# Redis host

Config as code and a few small scripts to build, load and check Blot's Redis
host (Amazon Linux 2023 arm64, `redis6` 6.2.x, RDB persistence, backups to S3).
Everything runs from the operator's Mac over ssh; nothing here is used by the
app. Part of blotcms/blot#2041.

**The current production host predates these scripts.** It was set up by hand
(its kernel has never been updated) and has drifted: backups and `stats.sh` run
from root's crontab out of `/home/ec2-user/*.sh` (`ec2-user`'s crontab only has
the two monitoring logs), sshd listens on port 3796 (the scripts do not change
the ssh port; the launch template/AMI user-data decides how you get in), and `redis6.conf` has `save 60 10000` and no
`maxmemory`. Build new hosts with these scripts and cut over to them.

## Files

| File | What it does |
| --- | --- |
| `redis.conf` | The Redis config, every non-default setting commented. |
| `launch.sh` | Launch an instance, bootstrap it, load data (**untested**, see below). |
| `bootstrap.sh <ssh-host>` | Install and configure Redis on a host (runs `host/setup.sh` via sudo). |
| `restore.sh <ssh-host> latest\|<name>\|list` | Restore an S3 backup onto a host. |
| `cutover.sh <old> <new>` | Move live traffic to a replica: FAILOVER, floating IP, backups (see below). |
| `readonly.sh <ssh-host> on\|off` | Refuse or accept writes (`min-replicas-to-write` 99 / 0). |
| `host/setup.sh` | Root-side setup: packages, config, sysctls, systemd units, cron. |
| `host/mount-instance-store.sh` | Mounts the NVMe instance store at `/backups`. |
| `bin/backup.sh` | Hourly and daily backup to S3 (cron). |
| `bin/redis-mem-log.sh`, `bin/tcpmem-log.sh` | Memory logging every 5 minutes (cron). |

`SSH_OPTS` (for example `SSH_OPTS="-i $HOME/key.pem -p 22"`) adds ssh options
to every script, or use a `~/.ssh/config` alias as `<ssh-host>`.

## Building a new host

1. `./launch.sh --type <instance-type> --from latest --key ~/key.pem`
   (`--from <backup-name>` for a specific backup, or `--from replica:<ip>` to
   replicate from a running Redis: give the live host's own private IP, not the
   floating IP, and it first raises that host's replica output buffer to
   `redis.conf`'s value so a multi-GB sync under load does not loop). This runs
   the next two steps for you. Use
   `--dry-run` first. **launch.sh has never been run**: it was written without
   the AWS CLI available, so watch the first run and expect to fix things.
   Or launch by hand with the launch template and do 2 and 3 yourself.
   `./launch.sh --list` lists the backups in S3. Add `--drill` for any
   throwaway host (a rehearsal, a restore test): it is named `drill-redis-*`,
   tagged `BlotDrill=true`, and gets `/etc/blot-redis/drill` before bootstrap,
   which stops `backup.sh` from ever uploading from it, even after a rehearsal
   cutover marks it active (otherwise it would overwrite and prune the
   production backups). `cutover.sh` warns when the new host is a drill host.
2. `./bootstrap.sh ec2-user@<ip>`
3. `./restore.sh ec2-user@<ip> latest` (add `--reference <current-redis-host>`
   to compare `DBSIZE` and keyspace), or on the new host
   `redis6-cli REPLICAOF <live-host-private-ip> 6379` and wait for
   `master_link_status:up`.

A host restored from a backup is a point-in-time copy, for a drill or for
disaster recovery. To move live traffic, always make the new host a replica of
the live one first (after a restore is fine: the full sync replaces the data),
so no writes made since the backup are lost.

Then move traffic to it with `cutover.sh` (next section).

## Cutover

```
./cutover.sh --dry-run --app-host <app-ssh-host> <old-ssh-host> <new-ssh-host>
./cutover.sh --app-host <app-ssh-host> <old-ssh-host> <new-ssh-host>
```

The dry run makes every check and prints the plan, the old cron jobs it will
turn off (labelled `ec2-user` or `root` by crontab) and the rollback command;
it changes nothing. The real run asks for `yes`, and only runs between :08-:25 and :38-:55 past the hour (backups and
sync validation run at :00 and :30) and not between 01:00 and 01:30 UTC (the
proxy's wildcard certificate renewal). `--any-time` skips that for rehearsals.

What it checks first: both hosts answer over ssh with passwordless sudo and run
Redis 6.2.x; the new host replicates from the old host's **primary private
IP** (from the floating IP it would replicate from itself once the IP moves),
its link is up and it is at most 16MB and 1s behind; it has
`min-replicas-to-write 0`, uses under 80% of its `maxmemory` and its last
background save did not fail (otherwise, with `stop-writes-on-bgsave-error yes`,
it refuses writes the moment it is promoted); it has as many `ssl:*:latest`
certificate keys as the old host (the proxy trusts Redis over its own copy, so
a missing one gets re-issued); it was set up by `bootstrap.sh`; no backup upload
is running; the AWS CLI works, both primary IPs are their interfaces' primary
addresses in the same subnet, and the floating IP is on the old host's
interface and configured on the old host.

What it does:

1. Stops `refresh-policy-routes@<if>.timer` on both hosts and adds the floating
   IP to the new host's interface (`ip addr add <ip>/32 ... noprefixroute`).
   `amazon-ec2-net-utils` only notices a moved IP when that timer fires (every
   ~60s), and an unserved IP is a black hole: a busy client's commands hang
   until it times out. With the address already up, the new host resets the
   clients' old connections the moment the IP moves and they reconnect at once.
2. Waits until no folder lock (`blog:*:folder-lock`) is held, then runs
   `FAILOVER TO <new-ip> 6379 TIMEOUT 2000` on the old host. Redis blocks
   every write there (scripts and `PUBLISH` too), waits for the new host to
   catch up, promotes it and makes the old host its replica. Blocked writes
   then get `READONLY`. If the new host does not catch up in time Redis gives
   up, the blocked writes run on the old host and the script stops, having
   changed nothing. If the switch hangs after the catch-up, the script runs
   `FAILOVER ABORT`. If the ssh session dies mid-FAILOVER, Redis carries on, so
   the script asks the old host how it ended (waiting or aborting if it is
   still in progress) and never touches the new host until the old host says
   whether it is the master or a replica of it; if it cannot tell, it stops.
3. Moves the IP: `aws ec2 assign-private-ip-addresses --allow-reassignment`.
   If the call fails (its timeout is only a socket timeout, and the move is
   asynchronous) it polls AWS for up to 10s for the IP to show up on the new
   host's interface and carries on if it does. Writes stay unavailable while it
   polls, which is why that is bounded. If it never shows up, the script runs
   FAILOVER back to the old host.
4. Deletes the app host's neighbour (ARP) entry for the IP (Docker containers
   share the host's table; in rehearsals the flush made no measurable
   difference either way, see "Rehearsal" below), waits for the new host's
   instance metadata to list it, and only then removes the IP from the old
   host and deletes the neighbour entry again. The move is asynchronous, and
   until the metadata lists the IP the VPC may still deliver to the old host,
   which as a replica answers (reads work, writes get `READONLY`); with the
   address gone those packets would be dropped. If the metadata has not listed
   the IP after 20s the address stays on the old host, with a warning that
   gives the `ip addr del` command to run there once AWS shows the IP on the
   new host (the refresh timer would also drop it).
5. Writes the IP to `/etc/blot-redis/floating-ip` on the new host (its backups
   start) and removes it on the old host.
6. Comments out the old host's crontab entries except the two monitoring logs
   (`ec2-user`'s crontab), after saving each crontab it changes to
   `~/crontab.before-cutover-*` (`ec2-user`'s) and
   `~/root-crontab.before-cutover-*` (root's, read with `sudo crontab`). The
   backups and `stats.sh` are in root's crontab. The hand-made backup scripts
   have none of `backup.sh`'s checks and upload to the same S3 names, so they
   would overwrite and prune the new host's backups. If a crontab cannot be
   rewritten the script carries on and reports it at the end.
7. Restarts the refresh timers, waits for the clients that were connected
   through the floating IP to reconnect on the new host, checks the new host
   takes writes, and prints how long each step took. If none of those clients
   arrived (Redis has switched, but traffic may be down: on a rollback AWS can
   take a while to route the IP back, see "Rehearsal" below), or step 4 or 6
   left something undone, it exits with an error listing each problem, the
   rollback command and how to restore the cron jobs it turned off.

Writes are unavailable from the FAILOVER until clients reach the new host.
That must stay well under the folder lock's 10s TTL (`app/sync/lock.js`): a
lock is lost when its key expires 10s after its last heartbeat, so depending
on where the window falls the limit is 6-9s. Aim for about 3s; the script warns
above 5s. It adds up durations that each come from one clock (the old host's
FAILOVER, this machine's wait, the new host's watcher), never subtracting
timestamps from different hosts.

### Rehearsal (8 Oct 2026, throwaway instances)

A hand-built 6.2.12 "old" host (the live host's AMI, kernel and
`amazon-ec2-net-utils` 2.3.0) and a bootstrapped x2gd.medium "new" host, with
probes doing a write every 10ms through the floating IP:

- Forward (4 runs): writes unavailable for 3.5-3.9s: FAILOVER 0.1-0.7s,
  `assign-private-ip-addresses` ~1.8s, then ~1s for the VPC to switch.
- Rollback (4 runs): 4.8s, 6.4s, 6.5s and ~16s. Moving the IP back to an
  interface that held it a minute earlier, the VPC kept delivering to (and its
  proxy ARP kept answering with the MAC of) the other interface for several
  seconds after the call returned. Gratuitous ARP from the new owner and
  skipping the neighbour flush made no difference, so a rollback will likely
  cost `[LOCK COMPROMISED]` restarts.
- Adding or removing an IP makes `amazon-ec2-net-utils` (2.3.0 and 2.7.x)
  reconfigure the interface on its next minute refresh: networkd drops and
  re-adds the primary address for ~0.1s, one ~0.22s stall on open
  connections. Step 1 stops the refresh timers so this happens after the
  switch, when step 7 restarts them.

**Do not deploy or restart the proxy around the cutover.** `proxy/deploy`
rolls back if Redis is unreachable, and the proxy's stale copy of each
certificate survives `openresty -s reload` but not a container restart.

**Rollback** is `cutover.sh` with the hosts swapped; it prints the exact
command, with `--allow-unbootstrapped` when the old host was not set up by
`bootstrap.sh`. It works because FAILOVER leaves the old host replicating from
the new one. On the hand-built host it also prints how to restore the cron
jobs it turned off, in both crontabs.

`config/redis/tests/cutover.sh` runs the whole script against Redis 6.2.12 and
6.2 containers with ssh and the AWS CLI stubbed (`.github/workflows/redis-cutover.yml`).

### Why FAILOVER and not `readonly.sh`

Freezing with `readonly.sh` and promoting with `REPLICAOF NO ONE` works on
6.2.12 (writes inside `EVAL` are refused too), but it takes several round
trips while writes are refused, and lifting the freeze is only safe before the
promotion. Script writes also fail as `ERR Error running script ...
-NOREPLICAS ...`, which the app does not recognise as Redis being unavailable.
FAILOVER does freeze, catch-up and promotion in one step inside Redis, in about
0.5s with a 400MB dataset under 50k writes/s on one CPU in Docker. It also
leaves the old host replicating from the new one, which is what rollback needs.

### Running bootstrap on a live host

`bootstrap.sh` is idempotent and does not restart a running Redis. It checks
the new config with a throwaway Redis, installs it, applies what Redis allows
with `CONFIG SET` (never `CONFIG REWRITE`) and lists the settings that need a
restart (for example `tcp-backlog`, and `LimitNOFILE` of the running process).
It will not lower `maxmemory` below the memory in use. Two things to know on a
host set up by hand: it adds `/etc/cron.d/blot-redis`, so remove the old
backup entries from root's crontab or backups run twice, and it prints a warning if an
existing sysctl file (e.g. `99-sysctl.conf`) sets a key that would override
`90-blot-redis.conf` at boot.

To change a setting: edit `redis.conf`, run `bootstrap.sh`, restart Redis if
it says so. `maxmemory` is about 70% of RAM, computed at bootstrap
(`REDIS_MAXMEMORY=10gb ./bootstrap.sh ...` to override).

## Disaster recovery

For when the master is gone (instance lost, data unusable) and no replica can
take over with `cutover.sh`. Everything written since the newest backup's
snapshot is lost (up to an hour), and the app's sync state can then disagree
with the clients' folders.

1. `./launch.sh --list` and pick the newest backup.
2. `./launch.sh --type x2gd.medium --from <backup-name> --key ~/key.pem`
   (or a larger type). This took 2m31s for 2.2M keys in the 8 Oct drill: ~35s
   to ssh, ~45s bootstrap, ~50s download and RDB check, ~13s load.
3. Check it on the host: `redis6-cli ROLE` is master, `DBSIZE` is about what
   it was on the old master, `INFO memory` is well under `maxmemory`, and
   the `ssl:*:latest` count (`redis6-cli --scan --pattern 'ssl:*:latest' | wc -l`)
   is about what it was, or the proxy re-issues the missing certificates.
4. Move the floating IP (`172.30.0.200` today) to it. Add the address on the
   host first, so it answers the moment the VPC moves it:
   ```
   ssh <new> 'sudo ip addr add <floating-ip>/32 dev ens5 noprefixroute'
   aws ec2 assign-private-ip-addresses --network-interface-id <new-eni> \
     --private-ip-addresses <floating-ip> --allow-reassignment
   ```
   If the old master comes back, make sure it no longer has the address
   (stop it, or `sudo ip addr del <floating-ip>/32 dev ens5` there).
5. Turn on its backups: `echo <floating-ip> | sudo tee /etc/blot-redis/floating-ip`,
   then `sudo -u ec2-user /usr/local/bin/backup.sh hourly` for a first upload.
6. Check the app: every client in `redis6-cli CLIENT LIST` has
   `laddr=<floating-ip>`, `/redis-health` is fine, and expect
   `[LOCK COMPROMISED]` container restarts from the outage. Then run sync
   validation for the blogs, since Redis lost what changed after the snapshot.

To rehearse it, run steps 1-3 with `launch.sh --drill` (it never uploads
backups), write down the commands for 4-5 with the drill host's interface,
and terminate the host.

### Increasing the Redis server size

Do this when the daily email says **resize now** (memory at 70% of
`maxmemory`) or the 80% alert fires; with `noeviction`, writes fail at the
limit. `maxmemory` is about 70% of RAM, computed when a host is bootstrapped,
so a bigger instance gets a proportionally bigger limit with no other change.
Resizing means a new host and a cutover; the instance is not stopped and
resized in place.

1. Launch the bigger host as a replica of the current master. Give the
   master's **primary private IP**, not the floating IP:
   `./launch.sh --type <bigger-type> --from replica:<current-master-primary-ip> --key ~/key.pem`
   (`--dry-run` first). It keeps the arm64 architecture, so pick a bigger
   size in the same family (the current host's type is in the EC2 console).
2. Check it: `master_link_status:up` on the new host, `DBSIZE` close to the old
   host's, `maxmemory` about 70% of its RAM, and the sample from
   `tcpmem-log.sh` arrives (`GET blot:redis-host:tcpmem` has `ram_total`).
3. `./cutover.sh --dry-run --app-host <app-ssh-host> <current-master> <new-host>`,
   then the same without `--dry-run`, inside the allowed windows (see
   Cutover). Do not deploy or restart the proxy around it.
4. Afterwards the old host replicates from the new one. Keep it for a few days,
   then terminate it. Do not roll back to a host whose interface held the
   floating IP recently: the VPC kept delivering to the other interface for
   several seconds after the move (see Rehearsal), which will likely cost
   `[LOCK COMPROMISED]` restarts. A rollback soon after a cutover is for an
   emergency only.

## What gets installed

- `/etc/redis6/redis6.conf` plus `/etc/redis6/blot-memory.conf` (`maxmemory`).
  The previous config is kept once as `redis6.conf.dist`.
- `/etc/sysctl.d/90-blot-redis.conf`: `vm.overcommit_memory=1`,
  `vm.swappiness=1`, `somaxconn` and `tcp_max_syn_backlog` 4096. `tcp_mem` is
  left at the kernel default. No swap.
- `blot-disable-thp.service` (THP `never` before Redis), `blot-instance-store.service`
  (mounts `/backups`; Redis only `Wants=` it, so it starts without it), and
  the `redis6` drop-in `zz-blot.conf` (`LimitNOFILE=65536`, `Restart=always`,
  long start/stop timeouts). It is named `zz-` so it sorts after the package's
  `limit.conf`, which would otherwise win.
- `/etc/cron.d/blot-redis`, as `ec2-user`: backups (hourly at :00, daily at
  03:05, log in `~/backup.log`, truncated monthly) and the two monitoring
  scripts every 5 minutes (`~/tcpmem.log`, `~/redis-mem.log`).
- journald `SystemMaxUse=100M`, logrotate for `/var/log/redis6`.
- `/etc/ssh/sshd_config.d/10-blot.conf`: key-only ssh (`PasswordAuthentication no`,
  `KbdInteractiveAuthentication no`, `PermitRootLogin no`), since ssh stays open
  to the internet. It is named `10-` so it sorts before the distro's
  `50-redhat.conf` (sshd keeps the first value it reads). Applied with
  `systemctl reload sshd`, and only if `sshd -t` passes; otherwise the file is
  removed with a warning.

### Backups

`bin/backup.sh` copies the RDB to `/backups` (local copies only; the instance
store is wiped on stop) and uploads to
`s3://blot-redis-backups/{hourly,daily}/<YYYY-MM-DD-hour-HH>.rdb`, keeping the
6 newest hourly, 7 newest daily and 10 local copies. It runs `BGSAVE` first unless
a save finished in the last minute, so a backup holds the data as of its
upload and a restore loses at most the time since then. It exits quietly without uploading on a drill host
(`/etc/blot-redis/drill`, from `launch.sh --drill`), or unless
the host is a master that accepts writes, `/etc/blot-redis/floating-ip` exists,
and the address in it is on the host. That file is written at cutover, so a
new or restored host never uploads (or prunes) alongside the live one. It works with an instance profile or keys in `~ec2-user/.aws`.

After each upload it stores `<iso-time> <hourly|daily> <s3-key> <bytes>` in the
Redis key `blot:redis-host:backup` (no TTL), which the daily email shows as the
time since the last backup. Like the sample below, it is best effort: a refused
write never fails the backup.

## Alerts

The app's scheduler (`app/scheduler/check-redis-host.js`, every 5 minutes on
the master) emails the admin address `REDIS_HOST_ALERT` when:

- the kernel's TCP memory count reaches 50% of `tcp_mem[1]` (where TCP memory
  pressure starts), or `TCPMemoryPressures` rises;
- Redis's memory reaches 80% of `maxmemory` (`noeviction`, so writes fail at
  the limit);
- `maxmemory` is 0 on a host marked active by `/etc/blot-redis/floating-ip`;
- the TCP memory sample is over 20 minutes old;
- the last background save failed (`stop-writes-on-bgsave-error yes`, so Redis
  refuses every write until one succeeds).

It also emails what happened since its last check (it keeps Redis's counters in
the state key below, and starts again after a restart): errors that mean Redis
refused writes (`OOM`, `MISCONF`, `NOREPLICAS`), any other error type with 100
or more in 5 minutes (`READONLY` during a cutover, `WRONGTYPE`...), rejected
connections, a restart or a different Redis process or host serving (a changed
`run_id` or version, or lower uptime), and commands in the slowlog that took
50ms or more.

Only the host can read the TCP counters, so `bin/tcpmem-log.sh` also writes
each sample to the Redis key `blot:redis-host:tcpmem` (no TTL; the app reads
its timestamp). A replica or a write-frozen master refuses that write, so the
app only ever sees the live master's sample. The host needs no mail setup.

The same sample carries the host's RAM and disk space, which only the host can
read, as extra `key=value` fields in bytes: `ram_total`, `ram_avail`,
`disk_root=<used>/<total>` and `disk_backups=<used>/<total>` (left out when
`/backups` is not a mount). They are not in `~/tcpmem.log`.

The daily email (`app/scheduler/daily/redis-server.js`) has one line from this
and Redis itself:
`**Redis:** memory 27% (resize in ~47 days), disk 21% (19 GB free), saved 3m ago, backed up 30m ago.`
Memory is `used_memory` against `maxmemory`; the bracket is when it would reach
70% of `maxmemory` at the rate it grew since the previous daily run (the daily
job keeps its figures in `blot:redis-host:daily-snapshot`), or "stable" if it is
flat or over a year away, and nothing on the first run. From 70% it says
**resize now**, linking to "Increasing the Redis server size". Disk is the root
disk from the sample; the `/backups` disk only appears when it is 80% full or
not mounted. A failed save, a backup over 2 hours old or none recorded, and a
missing or stale sample are called out in bold or in words.

Each condition is emailed once when it starts and once when it clears, with
what was sent kept in `blot:redis-host:alerts`. Emails are rate limited so a
noisy Redis cannot flood the inbox: the same condition is emailed at most once
an hour (a start or clear that comes sooner waits, and the email says if the
condition flapped meanwhile), and each kind of event at most once every 6 hours
(refused writes: every hour), with what happened in between merged into that
email (`CONDITION_MIN_INTERVAL` and `EVENT_COOLDOWN`). A Redis outage sends nothing
from here; `/redis-health` covers that. Print the current report with
`NODE_PATH=app node app/scheduler/check-redis-host.js`.

## AWS permissions

For the operator running `launch.sh`: `ssm:GetParameter` on
`/aws/service/ami-amazon-linux-latest/*`; `ec2:RunInstances` (on the launch
template and the resources it uses), `ec2:CreateTags`, `ec2:DescribeInstances`,
`ec2:ModifyInstanceAttribute`; `iam:PassRole` if the template has an instance
profile. For `cutover.sh`: `sts:GetCallerIdentity`,
`ec2:DescribeNetworkInterfaces` (needs `Resource: "*"`) and
`ec2:AssignPrivateIpAddresses` (can be scoped to the two network interfaces'
ARNs, or by tag). For the Redis host (instance profile, or the keys in `~ec2-user/.aws`
the current host uses): `s3:ListBucket` on `blot-redis-backups`, `s3:GetObject`
on `hourly/*` and `daily/*` (restore), and `s3:PutObject` and `s3:DeleteObject`
on the same (backups).

## Still manual

- Access to the host (ssh port and keys come from the launch template/AMI),
  and S3 credentials if it has no instance profile (`aws configure` as
  `ec2-user`; `launch.sh` pauses for this before restoring).
- Putting the floating IP on the first host and pointing the app and proxy at
  it (#2041). `cutover.sh` moves it from then on.
- Redis has no auth or TLS (the security group is the protection), no AOF, and
  is still Redis 6; those are separate pieces of work.

## Notes

- `redis6-check-rdb` from the package does not work (Redis chooses its mode from
  the program name, which must contain `redis-check-rdb`); `restore.sh` runs
  the check through a correctly named link to `redis6-server`.
- `readonly.sh` changes a runtime setting only; a restart makes Redis writable
  again.
- `BLOT_REDIS_SKIP_SYSTEMD=1` makes `host/setup.sh` usable inside a container
  without systemd, for testing.
