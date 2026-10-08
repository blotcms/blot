# Redis host

Config as code and a few small scripts to build, load and check Blot's Redis
host (Amazon Linux 2023 arm64, `redis6` 6.2.x, RDB persistence, backups to S3).
Everything runs from the operator's Mac over ssh; nothing here is used by the
app. Part of blotcms/blot#2041.

**The current production host predates these scripts.** It was set up by hand
(its kernel has never been updated) and has drifted: backups run from
`ec2-user`'s crontab out of `/home/ec2-user/*.sh`, sshd listens on port 3796
(the scripts do not change the ssh port; the launch template/AMI user-data
decides how you get in), and `redis6.conf` has `save 60 10000` and no
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
turn off and the rollback command; it changes nothing. The real run asks for
`yes`, and only runs between :08-:25 and :38-:55 past the hour (backups and
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
4. Deletes the app host's neighbour (ARP) entry for the IP (otherwise it keeps
   sending to the old host's MAC address, which the VPC drops, for 20-50s;
   Docker containers share the host's table), waits for the new host's
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
6. Comments out the old host's `ec2-user` crontab entries except the two
   monitoring logs, after saving the crontab to `~/crontab.before-cutover-*`.
   The hand-made backup scripts have none of `backup.sh`'s checks and upload
   to the same S3 names, so they would overwrite and prune the new host's
   backups. If the crontab cannot be rewritten the script carries on and
   reports it at the end.
7. Restarts the refresh timers, waits for the clients that were connected
   through the floating IP to reconnect on the new host, checks the new host
   takes writes, and prints how long each step took. If none of those clients
   arrived (Redis has switched, but traffic may be down: check the app host's
   neighbour entry for the IP), or step 4 or 6 left something undone, it
   exits with an error listing each problem, and the rollback command.

Writes are unavailable from the FAILOVER until clients reach the new host.
That must stay well under the folder lock's 10s TTL (`app/sync/lock.js`): a
lock is lost when its key expires 10s after its last heartbeat, so depending
on where the window falls the limit is 6-9s. Aim for about 3s; the script warns
above 5s. It adds up durations that each come from one clock (the old host's
FAILOVER, this machine's wait, the new host's watcher), never subtracting
timestamps from different hosts. Rehearse on two throwaway instances first: the script times the
`assign-private-ip-addresses` call and how long clients take to arrive, and a
run with `--no-neigh-flush` shows what the neighbour flush buys.

**Do not deploy or restart the proxy around the cutover.** `proxy/deploy`
rolls back if Redis is unreachable, and the proxy's stale copy of each
certificate survives `openresty -s reload` but not a container restart.

**Rollback** is `cutover.sh` with the hosts swapped; it prints the exact
command, with `--allow-unbootstrapped` when the old host was not set up by
`bootstrap.sh`. It works because FAILOVER leaves the old host replicating from
the new one. On the hand-built host it also prints how to restore the cron
jobs it turned off.

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
`ec2-user` crontab entries or backups run twice, and it prints a warning if an
existing sysctl file (e.g. `99-sysctl.conf`) sets a key that would override
`90-blot-redis.conf` at boot.

To change a setting: edit `redis.conf`, run `bootstrap.sh`, restart Redis if
it says so. `maxmemory` is about 70% of RAM, computed at bootstrap
(`REDIS_MAXMEMORY=10gb ./bootstrap.sh ...` to override).

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

### Backups

`bin/backup.sh` copies the RDB to `/backups` (local copies only; the instance
store is wiped on stop) and uploads to
`s3://blot-redis-backups/{hourly,daily}/<YYYY-MM-DD-hour-HH>.rdb`, keeping the
6 newest hourly, 7 newest daily and 10 local copies. It runs `BGSAVE` first if
the last save is over 15 minutes old. It exits quietly without uploading unless
the host is a master that accepts writes, `/etc/blot-redis/floating-ip` exists,
and the address in it is on the host. That file is written at cutover, so a
new or restored host never uploads (or prunes) alongside the live one. It works with an instance profile or keys in `~ec2-user/.aws`.

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
