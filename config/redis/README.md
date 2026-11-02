# Redis host

Config as code and a few small scripts to build, load and check Blot's Redis
(`redis6` 6.2.x on Amazon Linux 2023 arm64, RDB persistence, backups to S3).
Everything runs from the operator's Mac over ssh; nothing here is used by the
app. Part of blotcms/blot#2041.

Production Redis runs on the one production host, together with both units
(`blot-blue`, `blot-green`), an m6gd.xlarge on Amazon Linux 2023 since
2 November 2026 (#2261). There is no separate Redis host, no floating IP and no
Redis traffic over the network: the units reach it over the Unix socket
`/run/blot/redis/redis.sock` (`BLOT_REDIS_SOCKET`, and
`PROXY_REDIS_HOST=unix:/run/blot/redis/redis.sock` for the proxy), and ssh is
`ssh blot`. TCP 6379 stays on for replicas and is closed to everything else by
the host's firewall (see "Building a new host" in `config/host/README.md`).
Hourly, daily and weekly RDB backups go to `s3://blot-redis-backups` from
`/etc/cron.d/blot-redis`, and only on the host marked by
`/etc/blot-redis/active`.

The host is built and replaced with the host cycle (`config/host/cycle.sh`,
described in `config/host/README.md`), which uses these scripts: `launch.sh`'s
bootstrap and `promote.sh` to move Redis to the new host, and
`restore.sh` for disaster recovery. A bigger or newer host is a host cycle,
not a Redis-only change. The old two-host setup (a separate Redis instance,
the floating IP, `cutover.sh`) is gone.

## Files

| File | What it does |
| --- | --- |
| `redis.conf` | The Redis config, every non-default setting commented. |
| `launch.sh` | Launch an instance, bootstrap it, load data. |
| `bootstrap.sh <ssh-host>` | Install and configure Redis on a host (runs `host/setup.sh` via sudo). |
| `restore.sh <ssh-host> latest\|<name>\|list` | Restore an S3 backup onto a host. |
| `promote.sh <old> <new>` | Promote a replica to master with FAILOVER and move the `active` backup marker (see "Promotion"). |
| `readonly.sh <ssh-host> on\|off` | Refuse or accept writes (`min-replicas-to-write` 99 / 0). |
| `host/setup.sh` | Root-side setup: packages, config, sysctls, systemd units, cron. |
| `host/mount-instance-store.sh` | Mounts the NVMe instance store at `/backups` (a bind mount of a directory of the app's instance store on a combined host). |
| `bin/backup.sh` | Hourly, daily and weekly backup to S3 (cron). |
| `bin/redis-mem-log.sh`, `bin/tcpmem-log.sh` | Memory logging every 5 minutes (cron). |

`SSH_OPTS` (for example `SSH_OPTS="-i $HOME/key.pem"`) adds ssh options to
every script, or use a `~/.ssh/config` alias as `<ssh-host>` (`blot` is the
production host).

## Building a new host

For production use `config/host/cycle.sh` (`launch`, `replicate`), which builds
the combined host and makes its Redis a replica. These steps are for a
standalone Redis, such as a drill or a recovery rehearsal.

1. `./launch.sh --type <instance-type> --from latest --key ~/key.pem`
   (`--from <backup-name>` for a specific backup, or `--from replica:<ip>` to
   replicate from a running Redis: give the live host's own private IP, and
   it first raises that host's replica output buffer to
   `redis.conf`'s value so a multi-GB sync under load does not loop; on a
   bootstrapped master it already is). The full sync costs the master one
   extra save: on 8 Oct a ~63ms fork and a ~33s save, with no visible effect
   on its traffic, and the replica was in sync about a minute after
   `REPLICAOF`. This runs the next two steps for you. Use
   `--dry-run` first. Or launch by hand with the launch template and do 2 and 3
   yourself.
   `./launch.sh --list` lists the backups in S3. Add `--drill` for any
   throwaway host (a rehearsal, a restore test): it is named `drill-redis-*`,
   tagged `BlotDrill=true`, and gets `/etc/blot-redis/drill` before bootstrap,
   which stops `backup.sh` from ever uploading from it, even after a rehearsal
   promotion marks it active (otherwise it would add its own copies to the
   production backups). `promote.sh` warns when the new host is a drill host.
2. `./bootstrap.sh ec2-user@<ip>`
3. `./restore.sh ec2-user@<ip> latest` (add `--reference <current-redis-host>`
   to compare `DBSIZE` and keyspace), or on the new host
   `redis6-cli REPLICAOF <live-host-private-ip> 6379` and wait for
   `master_link_status:up`.

A host restored from a backup is a point-in-time copy, for a drill or for
disaster recovery. To move live traffic, always make the new host a replica of
the live one first (after a restore is fine: the full sync replaces the data),
so no writes made since the backup are lost.

Then promote it with `promote.sh` (next section).

## Promotion

```
./promote.sh --dry-run <old-ssh-host> <new-ssh-host>
./promote.sh <old-ssh-host> <new-ssh-host>
```

Promotes the replica on the new host with `FAILOVER` and moves the backup
marker. It does not move any IP: clients that should follow the new master
reach it by their own means (the units use the Redis on their own host, over
the socket). `cycle.sh switch` runs it as part of a host cycle.
The dry run makes every check and prints the plan and the rollback command; it
changes nothing. The real run asks for `yes`. It has no time-of-day rule, since
when to switch is the host cycle's job.

What it checks first: both hosts answer over ssh with passwordless sudo and run
Redis 6.2.x; the new host replicates from the old host's **primary private
IP**, its link is up and it is at most 16MB behind, with an ack in the last 3s; it has
`min-replicas-to-write 0`, uses under 80% of its `maxmemory` and its last
background save did not fail (a host set to `stop-writes-on-bgsave-error yes`
would refuse writes the moment it is promoted); it has as many `ssl:*:latest`
certificate keys as the old host (the proxy trusts Redis over its own copy, so
a missing one gets re-issued); and it was set up by `bootstrap.sh` (otherwise
nothing would back it up). A backup upload running during the promotion is
harmless: uploads are write-once with unique names and nothing prunes S3.

What it does:

1. Waits until no folder lock (`blog:*:folder-lock`) is held, then runs
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
2. Writes `/etc/blot-redis/active` on the new host (its backups start) and
   removes it on the old host (its backups stop; `backup.sh` checks the file,
   so no cron editing is needed).
3. Checks the new host is the master and takes a write, and that the old host
   replicates from it with its link up. A step that fails after the FAILOVER
   is reported with the command to run by hand, and the script exits 1.

**Do not deploy or restart the proxy around a promotion.** `proxy/deploy`
rolls back if Redis is unreachable, and the proxy's stale copy of each
certificate survives `openresty -s reload` but not a container restart.

**Rollback** is `promote.sh` with the hosts swapped; it prints the exact
command. It works because FAILOVER leaves the old host replicating from the new
one.

`config/redis/tests/promote.sh` runs the whole script against Redis 6.2.12 and
6.2 containers with ssh stubbed (`.github/workflows/redis-promote.yml`).

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
It will not lower `maxmemory` below the memory in use. On the production
host, which Redis shares with the units, always pass the shared limit
(`REDIS_MAXMEMORY=6gb`): without it setup applies 70% of RAM. It prints a warning if
an existing sysctl file (e.g. `99-sysctl.conf`) sets a key that would override
`90-blot-redis.conf` at boot.

To change a setting: edit `redis.conf`, run `bootstrap.sh`, restart Redis if
it says so. `maxmemory` is about 70% of RAM, computed at bootstrap
(`REDIS_MAXMEMORY=10gb ./bootstrap.sh ...` to override).

## Disaster recovery

Redis shares the host with the app, so losing the host loses the app and its
data volume too: use "Recovery" in `config/host/README.md` (`cycle.sh restore`),
which restores Redis with `restore.sh` as one of its steps and then does the
data volume and the units. The steps below are the Redis part by hand, and what
a rehearsal of it looks like.

For when the master is gone (instance lost, data unusable) and no replica can
take over with `promote.sh`. Everything written since the newest backup's
snapshot is lost (up to an hour), and the app's sync state can then disagree
with the clients' folders.

1. `./launch.sh --list --profile <aws-profile>` and pick the newest backup
   (its times are in your Mac's local time; the names are UTC hours).
2. `./launch.sh --type <instance-type> --from <backup-name> --key ~/key.pem --profile <aws-profile>`
   (the production host's type or larger). In the 8 Oct drills this took about 2.5 minutes for the
   full dataset: ~75s to ssh and bootstrap, ~50s download and RDB check, ~13s
   load.
3. Check it on the host: `redis6-cli ROLE` is master, `DBSIZE` is about what
   it was on the old master, `INFO memory` is well under `maxmemory`, and
   the `ssl:*:latest` count (`redis6-cli --scan --pattern 'ssl:*:latest' | wc -l`)
   is about what it was, or the proxy re-issues the missing certificates.
4. Point the app at it. In production this is `cycle.sh restore`, which also
   restores the data volume and units and moves the Elastic IP; there is no
   floating IP to move.
5. Turn on its backups: `sudo touch /etc/blot-redis/active`,
   then `sudo -u ec2-user /usr/local/bin/backup.sh hourly` for a first upload.
   A host launched with `--drill` also has `/etc/blot-redis/drill`, which
   makes `backup.sh` skip silently: remove it first if a drill host goes live.
6. Check the app: the units' clients in `redis6-cli CLIENT LIST` are on the
   Unix socket (`laddr=/run/blot/redis/redis.sock`), `/redis-health` is fine, and expect
   `[LOCK COMPROMISED]` container restarts from the outage. Then run sync
   validation for the blogs, since Redis lost what changed after the snapshot.

To rehearse it, run steps 1-3 with `launch.sh --drill` (it never uploads
backups). To also exercise `promote.sh`, make the drill host a replica of the
live master (`redis6-cli REPLICAOF <master-primary-ip> 6379` on it) and run
`promote.sh --dry-run`, then `REPLICAOF NO ONE`. Then write down the
commands for 5 for the drill host, and terminate the host by
its instance ID, after checking it has the `BlotDrill` tag and is not a
production instance.

### Increasing the Redis server size

Do this when the daily email says **resize now** (80% of `maxmemory`) or the
alert fires (90%); with `noeviction`, writes fail at the
limit. Redis shares the host's RAM with the units, so first try raising
`maxmemory` (check what the units and a background save's copy-on-write
leave; `REDIS_MAXMEMORY` at bootstrap, or `/etc/redis6/blot-memory.conf`). If
the host itself is too small, that is a host cycle onto a bigger instance, not
a Redis-only change: `config/host/cycle.sh --type <bigger-type> ... launch`,
then the phases in `config/host/README.md` ("Host cycle"). It keeps the arm64
architecture, so pick a bigger size in the same family. Check on the new host
before `switch`: `master_link_status:up`, `DBSIZE` close to the old host's,
`maxmemory` what you expect for its RAM, and the sample from `tcpmem-log.sh`
arrives (`GET blot:redis-host:tcpmem` has `ram_total`). Do not deploy or
restart the proxy around the promotion. The old host replicates from the new
one until `finish` (about a day after `settle`).

## What gets installed

- `/etc/redis6/redis6.conf` plus `/etc/redis6/blot-memory.conf` (`maxmemory`).
  The previous config is kept once as `redis6.conf.dist`.
- A Unix socket, `/run/blot/redis/redis.sock` (mode 777; TCP stays on), for
  clients on the same host. `/etc/tmpfiles.d/blot-redis.conf` creates its
  directory, owned by `redis6`, at every boot, since `/run` is a tmpfs and
  Redis exits at start if it cannot bind the socket. The unit has no
  sandboxing that would block it. A running Redis only gets the socket at its
  next restart: `unixsocket` and `unixsocketperm` cannot be changed with
  `CONFIG SET`, so `bootstrap.sh` lists them as needing a restart.
- `/etc/sysctl.d/90-blot-redis.conf`: `vm.overcommit_memory=1`,
  `vm.swappiness=1`, `somaxconn` and `tcp_max_syn_backlog` 4096. `tcp_mem` is
  left at the kernel default. No swap.
- `blot-disable-thp.service` (THP `never` before Redis), `blot-instance-store.service`
  (mounts `/backups`; Redis only `Wants=` it, so it starts without it), and
  the `redis6` drop-in `zz-blot.conf` (`LimitNOFILE=65536`, `Restart=always`,
  long start/stop timeouts, `OOMScoreAdjust=-900`, `OOMPolicy=continue` and
  `CPUWeight=1000`). On a shared host the kill order under memory pressure is
  the BGSAVE child (`oom-score-adj-values` in `redis.conf` lifts it to 1000),
  then sandbox jobs (also 1000, smaller), then `node-b` (900), then `node-a`,
  and never Redis; Redis also wins the CPU when it is contended.
  `OOMPolicy=continue` keeps that promise: under systemd's default a killed child
  stops the whole service. A killed child still fails the save. That is why
  `stop-writes-on-bgsave-error` is `no`: with `yes` the rehearsal measured over
  3 minutes of refused writes, because `save 300 100` only tries again 5 minutes
  after the last good one. A running Redis only gets `OOMScoreAdjust` at its next restart, but
  `OOMPolicy` at the next `daemon-reload`. The drop-in is named `zz-` so it sorts
  after the package's `limit.conf`, which would otherwise win.
- `/etc/cron.d/blot-redis`, as `ec2-user`: backups (hourly at :00, daily at
  03:05, weekly on Sundays at 03:35, log in `~/backup.log`, truncated monthly) and the two monitoring
  scripts every 5 minutes (`~/tcpmem.log`, `~/redis-mem.log`).
- journald `SystemMaxUse=100M`, logrotate for `/var/log/redis6`.
- `/etc/ssh/sshd_config.d/10-blot.conf`: key-only ssh (`PasswordAuthentication no`,
  `KbdInteractiveAuthentication no`, `PermitRootLogin no`), since ssh stays open
  to the internet. It is named `10-` so it sorts before the distro's
  `50-redhat.conf` (sshd keeps the first value it reads). Applied with
  `systemctl reload sshd`, and only if `sshd -t` passes; otherwise the file is
  removed with a warning.

### On a combined app and Redis host

`config/host/host/setup.sh` runs this setup with
`BLOT_REDIS_SHARED_INSTANCE_STORE=1`, which writes
`/etc/blot-redis/shared-instance-store`. The marker is explicit config, never
inferred from what is mounted, and a re-run without the variable leaves it in
place. With it, `mount-instance-store.sh` does not touch the NVMe disk, which
the app's `mount-instance-store.service` owns at `/var/instance-ssd`: it
bind-mounts `/var/instance-ssd/redis-backups` at `/backups` (and fails if
`/var/instance-ssd` is not mounted yet), so `backup.sh` and `tcpmem-log.sh`
work as they are. `blot-instance-store.service` is ordered after the app's
unit.

### Backups

`bin/backup.sh` copies the RDB to `/backups` (local copies only; the instance
store is wiped on stop) and uploads to
`s3://blot-redis-backups/{hourly,daily,weekly}/<YYYY-MM-DD-hour-HH>.rdb`, and
keeps the 10 newest local copies. The hourly runs at :00, the daily at 03:05 and
the weekly on Sundays at 03:35. Retention is the bucket's lifecycle rules, not
the script: `hourly/` expires after 1 day, `daily/` after 7 and `weekly/` after
30, so nothing lives past about a month (which also bounds how long deleted
content survives). `backup.sh` never deletes from S3, and its uploads are
write-once (`aws s3 cp --no-overwrite`, which needs a recent AWS CLI: check
`aws s3 cp help | grep no-overwrite` on the host, since an older CLI fails every
backup), so the host needs `s3:PutObject` only and a rerun within the same hour
leaves the first copy. It runs `BGSAVE` first unless
a save finished in the last minute, so a backup holds the data as of its
upload and a restore loses at most the time since then. It exits quietly without uploading on a drill host
(`/etc/blot-redis/drill`, from `launch.sh --drill`), or unless
the host is a master that accepts writes and `/etc/blot-redis/active` exists.
`promote.sh` writes that file, so a new or restored host never uploads
alongside the live one. It works with an instance profile or keys in `~ec2-user/.aws`.

After each upload it stores `<iso-time> <hourly|daily|weekly> <s3-key> <bytes>` in the
Redis key `blot:redis-host:backup` (no TTL), which the daily email shows as the
time since the last backup. Like the sample below, it is best effort: a refused
write never fails the backup.

### Offsite backups

The daily backup is also uploaded to a private Backblaze B2 bucket, so losing
the AWS account or region does not take the backups with it. `backup.sh` does
it after the S3 upload and records it in `blot:redis-host:offsite` (same format
as the backup key); the daily email shows it and flags it after 2 days. A B2
failure only logs a WARNING in `~/backup.log`: it never fails the backup or
stops the local prune.

- `/etc/blot-redis/offsite-bucket` holds one line, `s3://<bucket>`. The bucket
  name is not in the repo. Without the file (or empty), offsite is off, which
  is how drill hosts and hosts without the key stay inert.
- `~ec2-user/.aws` has a `blot-b2` profile (placeholders):
  ```
  # config
  [profile blot-b2]
  region = <b2-region>
  endpoint_url = https://s3.<b2-region>.backblazeb2.com
  request_checksum_calculation = when_required

  # credentials
  [blot-b2]
  aws_access_key_id = <key id>
  aws_secret_access_key = <key>
  ```
- The key can only write. Create it with the CLI, because the console's "Write
  Only" key type also grants delete and lifecycle rights:
  `b2 key create --bucket <bucket> <name> writeFiles,listBuckets`.
- A separate read key stays on the operator's machine, never on a server. It
  is what a recovery uses when AWS is unavailable. Create it like the write
  key, with read capabilities:
  `b2 key create --bucket <bucket> <name> listBuckets,listFiles,readFiles`.
- A lifecycle rule hides files after 23 days and deletes them 7 days later, so
  they last about 30 days, for privacy. Nothing prunes them from the host.

To restore from B2, with the read key's profile on your machine (here
`blot-b2-read`, set up like `blot-b2` above), pass the bucket, whose name is
not in the repo (it is in `/etc/blot-redis/offsite-bucket` on the host):

```
restore.sh --offsite blot-b2-read s3://<bucket> <ssh-host> latest
```

`list` and a backup name work as for S3, and `launch.sh --from latest --offsite
blot-b2-read s3://<bucket>` does the same on a new host. Only `daily/` backups
are offsite. Your machine lists and downloads the backup, then streams it to
the host over ssh, so it needs disk space for one backup and the host needs no
AWS or B2 key. After that it is checked and loaded as with S3. The speed is
your upload speed: the 1 Nov 2026 drill took about 33 minutes from a home
connection, nearly all of it sending the file, against a few minutes from S3.

## Alerts

The app's scheduler (`app/scheduler/check-redis-host.js`, every 5 minutes on
the master) emails the admin address `REDIS_HOST_ALERT` when:

- the kernel's TCP memory count reaches 50% of `tcp_mem[1]` (where TCP memory
  pressure starts), or `TCPMemoryPressures` rises;
- Redis's memory reaches 90% of `maxmemory` (`noeviction`, so writes fail at
  the limit; the daily email warns from 80%);
- `maxmemory` is 0 on a host marked active by `/etc/blot-redis/active`;
- the TCP memory sample is over 20 minutes old;
- the last background save failed (`stop-writes-on-bgsave-error no`, so Redis
  keeps taking writes, but nothing new reaches disk until one succeeds);
- the last backup in `blot:redis-host:backup` is over 3 hours old, or the last
  offsite one in `blot:redis-host:offsite` over 50 hours (two missed runs). A
  missing key is quiet, an unreadable value alerts.

It also emails what happened since its last check (it keeps Redis's counters in
the state key below, and starts again after a restart): errors that mean Redis
refused writes (`OOM`, `MISCONF`, `NOREPLICAS`), any other error type with 100
or more in 5 minutes (`READONLY` during a promotion, `WRONGTYPE`...), rejected
connections, a restart or a different Redis process or host serving (a changed
`run_id` or version, or lower uptime), and commands in the slowlog that took
50ms or more.

Only the host can read the TCP counters, so `bin/tcpmem-log.sh` also writes
each sample to the Redis key `blot:redis-host:tcpmem` (no TTL; the app reads
its timestamp). A replica or a write-frozen master refuses that write, so the
app only ever sees the live master's sample. The host needs no mail setup.

The same sample carries the host's RAM and disk space, which only the host can
read, as extra `key=value` fields in bytes: `ram_total`, `ram_avail`,
`disk_root=<used>/<total>/<available>` and `disk_backups=<used>/<total>/<available>`
(from `df`, whose available column is less than total minus used when blocks are
reserved; `disk_backups` is left out when
`/backups` is not a mount). They are not in `~/tcpmem.log`.

The daily email (`app/scheduler/daily/redis-server.js`) has two lines from this
and Redis itself:
`Redis: memory 27% (resize in ~58 days, 8 GB free), saved 3m ago, backed up 30m ago, offsite 9h ago`
`Server: disk 21% (stable, 19 GB free), RAM 75% available (12 GB)`
Memory is `used_memory` against `maxmemory`; disk is the root disk from the
sample, and RAM the host's available memory. Each is `percent (trend, free space)`: the trend is when it would reach
its limit (80% of `maxmemory`, 80% of the disk) at the rate it grew over the
last week, or "stable" if it is flat or over a year away, and left out until
there is an earlier reading. The daily job keeps the last 8 daily readings in
`blot:redis-host:daily-memory-history` and `blot:redis-host:daily-disk-history`
(the disk's are tagged with the host, so a replacement host starts afresh; see
`app/scheduler/daily/trend.js`). At the limit it says **resize now**; for
memory that links to "Increasing the Redis server size". The `/backups` disk
only appears when it is 80% full or not mounted. A failed save, a backup over 2
hours old or none recorded, and a missing or stale sample are called out in bold
or in words.

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
profile. For the host's backups (keys in `~ec2-user/.aws`; the combined host has no instance profile on purpose, since the units use host networking and could read the instance metadata service): `s3:ListBucket` on `blot-redis-backups`, `s3:GetObject`
on `hourly/*`, `daily/*` and `weekly/*` (restore), and `s3:PutObject` on the same
(backups; no delete or overwrite rights are needed).

## Still manual

- Access to the host (ssh port and keys come from the launch template/AMI),
  and S3 credentials if it has no instance profile (`aws configure` as
  `ec2-user`; `launch.sh` pauses for this before restoring).
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
