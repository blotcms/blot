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
| `readonly.sh <ssh-host> on\|off` | Refuse or accept writes (`min-replicas-to-write` 99 / 0). |
| `host/setup.sh` | Root-side setup: packages, config, sysctls, systemd units, cron. |
| `host/mount-instance-store.sh` | Mounts the NVMe instance store at `/backups`. |
| `bin/backup.sh` | Hourly and daily backup to S3 (cron). |
| `bin/redis-mem-log.sh`, `bin/tcpmem-log.sh` | Memory logging every 5 minutes (cron). |

`SSH_OPTS` (for example `SSH_OPTS="-i $HOME/key.pem -p 22"`) adds ssh options
to every script, or use a `~/.ssh/config` alias as `<ssh-host>`.

## Building a new host

1. `./launch.sh --type <instance-type> --from latest --key ~/key.pem`
   (`--from <backup-name>` for a specific backup, or `--from replica:<host>` to
   replicate from a running Redis). This runs the next two steps for you. Use
   `--dry-run` first. **launch.sh has never been run**: it was written without
   the AWS CLI available, so watch the first run and expect to fix things.
   Or launch by hand with the launch template and do 2 and 3 yourself.
2. `./bootstrap.sh ec2-user@<ip>`
3. `./restore.sh ec2-user@<ip> latest` (add `--reference <current-redis-host>`
   to compare `DBSIZE` and keyspace), or on the new host
   `redis6-cli REPLICAOF <host> 6379` and wait for `master_link_status:up`.

Before the app uses a replica, promote it (`cutover.sh` will do this):

1. `./readonly.sh <old-host> on` freezes writes on the old host (`NOREPLICAS`).
2. Wait until the new host's `master_repl_offset` equals the old host's.
3. `redis6-cli REPLICAOF NO ONE` on the new host.
4. Move the floating IP to the new host (or repoint the app), and write that
   IP to `/etc/blot-redis/floating-ip` on the new host so its backups start.

Undo with `./readonly.sh <old-host> off` if anything fails before step 4.

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
profile. For the Redis host (instance profile, or the keys in `~ec2-user/.aws`
the current host uses): `s3:ListBucket` on `blot-redis-backups`, `s3:GetObject`
on `hourly/*` and `daily/*` (restore), and `s3:PutObject` and `s3:DeleteObject`
on the same (backups).

## Still manual

- **Cutover.** Pointing the app and proxy at a new host is not scripted yet;
  `cutover.sh` comes with the floating-IP work (#2041). The old logic (update
  `BLOT_REDIS_HOST` in `/etc/blot/secrets.env`, restart the containers,
  replace the proxy container) is in git history:
  `git show f5190d3ec:config/redis/scripts/provision-and-restore.sh`, lines
  353-413.
- Access to the host (ssh port and keys come from the launch template/AMI),
  and S3 credentials if it has no instance profile (`aws configure` as
  `ec2-user`; `launch.sh` pauses for this before restoring).
- The floating IP and `/etc/blot-redis/floating-ip`.
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
