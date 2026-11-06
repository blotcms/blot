# Proxy host setup

Setup for the production host: one EC2 instance (an m6gd.xlarge on Amazon Linux
2023, arm64) that runs Redis 6.2 (the `redis6` systemd service) and both units,
`blot-blue` and `blot-green` (OpenResty and two Node processes each, with the
nsjail sandbox inside). The units reach Redis over a Unix socket,
`/run/blot/redis/redis.sock` (`BLOT_REDIS_SOCKET`, and
`PROXY_REDIS_HOST=unix:/run/blot/redis/redis.sock` for the proxy). The
production Elastic IP is on this host, and there is no separate Redis host or
floating IP. The proxy itself is not installed from here: deploy it with `npm run deploy-units` or the Deploy workflow (see
[`proxy/deploy/README.md`](../../proxy/deploy/README.md)).

```
npm run deploy-host
```

Sources `/etc/blot/openresty-deploy-environment.sh` on your Mac, then runs
`deploy.sh`, which ssh's to the host as `ec2-user`. It needs `SSH_KEY` (path to
the private key) and `PUBLIC_IP` (the host), and optionally `SSH_PORT`
(default 22). Re-running it is safe; it replaces what it installed last time.
On a new host run `deploy.sh` directly (see [Moving to a new host](#moving-to-a-new-host)).

## What it installs

| Here | On the host |
| --- | --- |
| `scripts/` (all of it, replacing the old directory) | `/home/ec2-user/scripts/` |
| `scripts/unit-mem-log.sh`, `scripts/unit-mem-summary.sh` | `/usr/local/bin/` |
| (written by `deploy.sh`) | `/etc/cron.d/blot-unit-mem` (runs `unit-mem-log.sh` every minute as root) |
| `scripts/mount-instance-store.service` | `/etc/systemd/system/mount-instance-store.service` (enabled; started only if `/var/instance-ssd` is not mounted yet) |
| `scripts/docker.service.d/10-instance-store.conf` | `/etc/systemd/system/docker.service.d/10-instance-store.conf` |
| `fail2ban/filter.d/*.conf`, `fail2ban/jail.local`, `fail2ban/fail2ban.local` | `/etc/fail2ban/` (then creates any `logpath` in `jail.local` that is missing and restarts fail2ban) |
| `scripts/fail2ban.service.d/10-instance-store.conf` | `/etc/systemd/system/fail2ban.service.d/10-instance-store.conf` |
| (written by `deploy.sh`) | `X11Forwarding no` in `/etc/ssh/sshd_config`, and on Amazon Linux 2023 in `/etc/ssh/sshd_config.d/12-blot-x11.conf` |
| `logrotate/*` | `/etc/logrotate.d/` |
| `tmpfiles.d/blot.conf` | `/etc/tmpfiles.d/blot.conf` (creates `/run/blot`) |
| `.bashrc` | `/home/ec2-user/.bashrc` (must print nothing to stdout in a non-interactive shell: scp is SFTP on Amazon Linux 2023) |

The `nginx-*` fail2ban jails ban `http,https` over TCP and, with a second
`iptables-multiport` action named `<jail>-udp`, over UDP too (HTTP/3 is UDP 443).
They deliberately do not use `iptables-allports`, which would also lock a
banned IP out of ssh. Neither does `recidive`, the week-long ban for repeat
offenders: it bans the same web ports. It used `iptables-allports` until 5 Nov
2026, when GitHub Actions runners that had been given an address a scraper once
used could not reach ssh, and deploys hung on their first `ssh`.

## Unit memory log

`unit-mem-log.sh` appends to `/var/instance-ssd/logs/unit-mem.log` (instance
store, so it survives deploys; about 30 days are kept). Each cron run takes four
samples 15 seconds apart. Per sample there is one line per container
(`blot-blue`, `blot-green`, and the sandbox cgroups) with `anon`, `file`, `shmem`,
`limit` and `oom_kill` from the container's cgroup (v1 or v2), `node_max` (the
biggest node process), `node_a`, `node_b` and `node_other` (the two app
processes and any other node, such as a script run with `docker exec`), `git`
and `git_n` (the summed RSS and count of the unit's git processes, which share
its limit) and `top=comm:bytes` (the biggest other process, i.e. a
pandoc/exiftool spike), `peak` (the cgroup's high-water mark, v2 only), and
one `name=host` line with `mem_available`. Where the host has a sandbox subtree
(#2257) there are also `name=blot-sandbox-<unit>` and
`name=blot-sandbox-<unit>-browser` lines: jobs are short, so read their `peak`
and `oom_kill`.
`anon+shmem` is the memory that can't be reclaimed; the cgroup limit also counts
page cache. Summarise it with:

```
unit-mem-summary.sh [logfile]
```

(per container: max and p99 anon+shmem, max node_max, max oom_kill, top 5 child
processes; host: lowest mem_available.)

## Permanent bans

The `manual-permaban` jail holds ranges we ban by hand and keep banned. Bans
are dropped in the kernel (TCP and UDP 80/443), so a banned client costs no TLS
handshake. The ranges are kept in fail2ban's database on the host
(`/var/lib/fail2ban/fail2ban.sqlite3`), not in this repo, so they stay out of
the public history. They persist across fail2ban restarts because the jail
turns off ban-time increment: with it on, a restart rewrote the permanent
`-1` to `bantime.maxtime` and the ban ended a week after it was added.

```
sudo fail2ban-client set manual-permaban banip 203.0.113.0/24      # add
sudo fail2ban-client set manual-permaban unbanip 203.0.113.0/24    # remove
sudo fail2ban-client status manual-permaban                        # list
```

Moving to a new host: see [Moving to a new host](#moving-to-a-new-host).

## Reboots

Do not reboot the production host until there are several hosts sharing the
load (planned). With one host a reboot is downtime: Redis and both units go
down together. Kernel and other OS security updates that need a reboot wait for
that, unless the operator decides otherwise for a specific critical advisory.
Updates that do not need a reboot can be applied as usual. A new host from the
host cycle is how the OS gets refreshed in the meantime.

## Moving to a new host

A new host is built on Amazon Linux 2023 (arm64) and runs Redis alongside the
units. `bootstrap.sh` does the root-side OS and Redis setup, then `deploy.sh`
installs the files in the table above onto
it. The rest is state that lives on the host and has to be carried across or
recreated. Do it before pointing traffic at the new host.

```
config/host/launch.sh --type <instance-type> --key-name <aws-key-pair> --key <private-key> --ssh-port N --redis-maxmemory <value>
```

`launch.sh` starts the instance (newest AL2023 arm64 AMI, the app subnet, the
host security group, IMDSv2 only, a 30 GB gp3 root (`--root-gb`), termination
protection on) and runs `bootstrap.sh` on it. The security group admits
TCP 80 and 443 and UDP 443 (HTTP/3) from anywhere. `--ssh-port` goes in user data, so
the first connection already uses that port. `--redis-maxmemory` (or
`REDIS_MAXMEMORY`) is required and has no default: the Redis setup's 70% of RAM
is wrong on a host the units share. Afterwards it checks from your machine
that port 6379 is not reachable on the host's public address, and if it is it
stops and says the instance is still running. It moves no Elastic IP and starts no replication; it ends by printing the
`deploy.sh` command to run next. On
a new host run `deploy.sh` directly, as that prints it: `npm run deploy-host`
sources the production host's `PUBLIC_IP` over the one you set. Run it with
`--dry-run` first to see the `run-instances` call, `--drill` for a throwaway, `--list` for the hosts it has launched. The key pair name, key
and port can be set as `BLOT_HOST_KEY_NAME`, `BLOT_HOST_SSH_KEY` and
`BLOT_SSH_PORT`.

The `deploy` user's ssh public key is not in the repo. `launch.sh` finds it,
first match wins, in `--deploy-public-key FILE`, `BLOT_DEPLOY_PUBLIC_KEY` (the
key itself), `~/.ssh/blot-deploy.pub`, and the `BLOT_DEPLOY_PUBLIC_KEY`
variable of the GitHub `deploy` environment (read with `gh`). It prints which
one it used, never the key, and stops if the key is not one `ssh-` or `ecdsa-`
line. With none found a real launch stops, since the Deploy workflow could not
reach the host; `--drill` and `--dry-run` go on without. If
`~/.ssh/blot-deploy.pub` is lost:

```
gh variable get BLOT_DEPLOY_PUBLIC_KEY --env deploy --repo blotcms/blot > ~/.ssh/blot-deploy.pub
```

If both are lost, derive it from the private key (`ssh-keygen -y -f <key>`) or
copy it from the live host's `/home/deploy/.ssh/authorized_keys`, then store it
in both places again (see `scripts/deploy/README.md`).

To run only the OS setup on an existing host:

```
REDIS_MAXMEMORY=... BLOT_SSH_PORT=... BLOT_DEPLOY_PUBLIC_KEY="ssh-..." config/host/bootstrap.sh <ssh-host>
```

It copies `host/`, `scripts/deploy/setup-deploy-user.sh` and the Redis host
files (`config/redis`'s `redis.conf`, `bin/` and `host/`) to the host and runs
`host/setup.sh` with sudo; `REDIS_MAXMEMORY` is required, the other two are
optional, and `SSH_OPTS` works as in `config/redis/bootstrap.sh`. `setup.sh` refuses to run anywhere but
Amazon Linux 2023, is safe to re-run, and never starts or restarts docker or
upgrades a package. It:

- installs `docker`, `fail2ban-server`, `iptables-nft`, `nftables`, `rsyslog`, `cronie`,
  `chrony`, `rsync`, `xfsprogs`, `nvme-cli`, `redis6` and `logrotate`, and links
  `redis6-cli` as `/usr/local/bin/redis-cli`;
- enables docker without starting it, checks cgroup v2, and adds a drop-in that
  orders docker after `redis6.service`; `ec2-user` joins the `docker` group;
- installs `blot-sandbox-cgroup.service`, ordered before docker, which makes
  `/sys/fs/cgroup/blot-sandbox/{blue,green}` for the units' nsjail sandbox
  (`app/sandbox`). Each is capped at 512M of memory (no swap), 256 pids and a
  `cpu.weight` of 25. Nothing uses them until `BLOT_SANDBOX=1` is set in the
  proxy env file (`proxy/deploy/proxy.env.example`). It also makes
  `{blue,green}-browser` for the browser job, one Chromium at a time, capped at
  1G (no swap, the whole job killed at the limit), 512 pids, a `cpu.weight` of
  25 and 1.5 CPUs;
- creates the `deploy` user (`scripts/deploy/setup-deploy-user.sh`);
- with `BLOT_SSH_PORT`, sets sshd's port in `/etc/ssh/sshd_config.d/11-blot-port.conf`
  (sshd then listens on that port only);
- installs the `check_docker_health.sh` cron entry, enables `crond`, `rsyslog`,
  `chronyd` and `fail2ban` (the last is started by `deploy.sh`), creates
  `/var/www/blot/data` and `/var/www/blot/app/blog/static`, and sets
  `net.ipv4.tcp_migrate_req = 1`;
- loads a firewall for Redis, then runs `config/redis/host/setup.sh` with
  `REDIS_MAXMEMORY` and `BLOT_REDIS_SHARED_INSTANCE_STORE=1`. Redis has no
  password and `redis.conf` binds every address, so `blot-redis-firewall.service`
  loads `/etc/nftables/blot-redis.nft` before Redis starts: port 6379 is open
  from loopback and the VPC's range on the main interface (both read from the
  instance metadata) and dropped from everything else, docker bridges and IPv6
  included. The file replaces only its own table, so fail2ban's and docker's
  rules stay. `redis6` `Requires=` the unit, so it does not start if the rules
  fail to load. Re-running reloads the unit and never restarts Redis. Check it
  with `sudo nft list table inet blot_redis`.
- loads a firewall for the units: they run as uid 1000 with `--network host`,
  so `blot-app-firewall.service` loads `/etc/nftables/blot-app.nft` before
  docker starts, refusing uid 1000 in `system.slice` (the units' docker scopes)
  the instance metadata service and the rest of 169.254.0.0/16, RFC 1918,
  CGNAT and IPv6 unique local and link-local addresses. Loopback stays open,
  as does DNS to the VPC's resolver. ec2-user is uid 1000 on the host too; its
  ssh sessions and cron jobs are in `user.slice`, so they keep the metadata
  service. Its own table and unit, so it never holds up Redis. The deploy's
  `verify-container` fails if a unit can reach the metadata address. Check it
  with `sudo nft list table inet blot_app`.

On the first run Redis's `/backups` cannot be mounted yet: it is a bind mount of
`/var/instance-ssd/redis-backups`, and `deploy.sh` mounts the instance store
afterwards. `deploy.sh` then starts `blot-instance-store.service`, so the
warning from the Redis setup can be ignored. A new host has no
`/etc/blot-redis/active`, so `backup.sh` does not upload from it yet.

`config/host/tests/setup.sh` runs it in Docker, and `config/host/tests/deploy.sh`
runs `deploy.sh` on top of it. Still by hand:

- **Permanent bans** (`manual-permaban`). The only fail2ban state worth keeping;
  the nginx jails' bans last 30-60 minutes and `recidive` a week. From your
  Mac, save the list from the old host and ban it on the new one, after
  `deploy.sh`. The file is one address or CIDR per line and belongs in the
  gitignored `data/` of the main checkout; the script prints counts only:

  ```
  config/host/bans.sh export <old-host> data/bans.txt
  config/host/bans.sh import <new-host> data/bans.txt
  ```

  `export` also reads bans a restart dropped from fail2ban's database (needs
  `sqlite3` on the host). `import` refuses the whole file if a line is not an
  address or CIDR, skips what is banned, and fails if any is not listed after.
- **Wildcard certificate** files in `/etc/ssl/private/` (`letsencrypt-domain.pem`
  and `.key`), written from Redis; `blue-green.sh` won't start a proxy
  container without them.
- Then `deploy.sh` and the Deploy workflow. docker is enabled but
  stays stopped until the instance store is mounted.

Nothing in `proxy/` or the units needs copying: custom-domain
certificates are in Redis and the proxy cache refills itself.

X11 forwarding is turned off in `sshd_config`, which is enough on Amazon Linux 2.
On Amazon Linux 2023 sshd reads `sshd_config.d/*.conf` first and uses the first
value it finds, and `50-redhat.conf` there sets `X11Forwarding yes`, so
`deploy.sh` also writes `sshd_config.d/12-blot-x11.conf` (after `10-blot.conf`
and `11-blot-port.conf`, which other setup scripts own) wherever `sshd_config`
includes that directory.

The systemd files are installed and `daemon-reload`ed; docker is never restarted,
so the mount-before-docker ordering takes effect at the next reboot. The instance
store unit is also enabled, and started if `/var/instance-ssd` is not a
mountpoint, so on a new host the log directory exists before fail2ban starts; on
a running host it is mounted and nothing is started or remounted.

`/var/www/blot/data` is a plain directory on the root disk, created by
`host/setup.sh`. A host set up when it was a mounted EBS volume has
`mount-data-volume.service` and a docker drop-in that ran its script before
docker started; `host/setup.sh` disables and deletes both, and `deploy.sh`
removes the legacy `mount-data-disk.service` (its script no longer exists on the
host).

The install paths are load-bearing: `mount-instance-store.service` hardcodes
`/home/ec2-user/scripts/mount-instance-store.sh`.

## Host cycle

`cycle.sh` moves everything onto a fresh host, so upgrades and resizes mean
building a new host rather than patching one. It wraps the scripts above,
`config/redis/promote.sh` and `scripts/deploy/units.sh`, and adds little of its
own (see the usage at the top of the file). Blog folders and git repos are in
S3, so no files move: a cycle is Redis replication, the env files, the units
and the Elastic IP. Rehearse it with `--drill` on hosts tagged `BlotDrill=true`.

```
config/host/cycle.sh --production --type m6gd.xlarge [--root-gb N] --cycle <name> launch <old>
config/host/cycle.sh --production [--old-redis <host>] replicate <old> <new>
config/host/cycle.sh --production [--old-redis <host>] app <old> <new>
config/host/cycle.sh --production --eip <id> --bans-file data/bans.txt --old-direct <host> [--old-redis <host>] switch <old> <new>
config/host/cycle.sh --production --eip <id> --old-direct <host> settle <old> <new>
config/host/cycle.sh --production --eip <id> --old-instance <id> finish <old> <new>
config/host/cycle.sh status <old> <new>
```

Each phase takes `--dry-run`, can be run alone, and works out what is left by
looking at the hosts, so after a failure fix the cause and run it again. Check
`status` first if you have lost track. Things to know:

- **Names.** `<old>`, `<new>` and the others are ssh names that work with plain
  `ssh`, as `ec2-user`. The old app host's only public address is the Elastic IP,
  so from `switch` on it needs `--old-direct`: an alias of its private IP with
  `ProxyJump <new>`. `switch` refuses an alias of the Elastic IP, and tries the
  way in before it freezes anything.
- **`<new>` after the move.** Moving the Elastic IP releases the new host's
  launch-time address, which `<new>` is an alias of. From then on `switch` and
  `settle` put an `ssh` in front on `PATH` that sends `<new>` to the Elastic IP
  (keeping its host key check), so they work whether or not the alias is edited;
  `-F` reaches `ProxyJump` too. Before `finish`, and for your own ssh, change
  `HostName` for `<new>` in `~/.ssh/config` to the Elastic IP.
- **The new host's key.** `launch` connects without checking or keeping the
  host key, so before you add `<new>` to `~/.ssh/config`, record its key and
  check it against the fingerprint cloud-init printed:
  `ssh-keyscan -p <port> -t ed25519 <address>` and
  `aws ec2 get-console-output --instance-id <id> --latest` (the `ED25519` line).
  After `switch`, the Elastic IP's entry in your `known_hosts` is still the old
  host's key: replace it with the new host's.
- **From a worktree.** `app` and `settle` deploy through `scripts/deploy/units.sh`,
  which refuses unless the checkout is on `master`. A worktree detached at
  `origin/master` needs `SKIP_BRANCH_CHECK=true`; the image is the old host's,
  not the checkout's, either way.
- **Two hosts.** Only a host that still has a separate Redis host (the first
  cycle, from before 2 November 2026) needs `--old-redis`, also for later
  phases that promote. Without it `<old>` is taken to run Redis too, which is
  the case now.
- **The root disk.** `launch` passes `--root-gb` to `launch.sh` (default 30 GB:
  the OS, Docker with two images during a deploy, and Redis's dump in
  `/var/lib/redis6` twice over while a save runs).
- **Deploys pause** at `app` and resume at the end of `settle`: `/etc/blot/deploy-paused`
  on both hosts stops `proxy/deploy/blue-green.sh`, however a deploy was started.
  The cycle's own deploys pass `PROXY_DEPLOY_IGNORE_PAUSE=1`. If you abandon a
  cycle, remove the file from both.
- **`app`** copies `secrets.env` and `proxy.env` from the old host and writes the
  socket settings into the new host's copy only. It deploys the image the old
  units run, with `verify-container` skipping its Redis write, because the
  replica refuses it. Other writes fail too until the switch: dashboard pages
  may not work, and nothing on the new host should be judged by them yet. The
  deploy also fills the host's static directory from the image; `app` and the
  checks before `switch` fetch `/layout.css` from the `cdn.` host to prove it.
- **The freeze.** `switch` first turns on the app's read-only mode
  (`scripts/read-only.js`, reason `host cycle`) through the old units, waits 3
  seconds for requests in flight, then up to 2 minutes for every folder lock
  to go, and only then promotes. The new host's proxy cache is emptied during
  that wait. Writes get a 503 the clients retry, and syncs
  wait before taking their lock. FAILOVER loses no write by itself; the freeze
  is there so that no sync is cut off half way (its files in S3, its entries
  not yet in Redis) and nothing writes to what is about to become a replica.
  The freeze is a Redis key with a TTL (`--freeze-ttl`, default 900 seconds),
  so it follows the promotion, and `switch` lifts it through the new host as
  soon as the site answers through the Elastic IP. Only the promotion and the
  Elastic IP move happen inside it: stopping the old units, importing the
  permabans and the backup markers come after, since the old units get no
  traffic once the address has moved and their Redis is then a replica. If the lock wait fails, `switch` lifts
  the freeze again before it stops; one it finds on for any other reason, it
  refuses to touch. The old units are stopped but not removed, and the old
  Redis stays a replica of the new one.
- **Backup credentials.** `app` copies `~/.aws` from the old Redis host unless the
  new host's already work. The host has no instance profile on purpose (the
  units use host networking and could read the instance metadata service), so
  backups to S3 and offsite to B2 (the `blot-b2` profile) use the keys in
  `~ec2-user/.aws`. If the old host has none, put the `blot` key there as
  `[default]` on the new host first. `app` also copies the storage bucket's
  offsite settings from the old host: the `blot-b2-storage` profile (its
  credentials and config sections) and `/etc/blot/storage-offsite-bucket`.
  Without them the new host's daily sync is off, and the daily email calls
  it overdue after 2 days. A drill gets neither.
- **`settle`** forces a rolling deploy of the same image, because a plain one
  skips units already on it, and that restart is what runs the steps that failed
  on the replica. Then deploys resume.
- **`finish`** terminates only the instances named with `--old-instance`, never
  `<new>` or the holder of the Elastic IP, and only once `settle` has run. Run
  it about a day after `settle`. It stops at termination protection and prints
  the command that lifts it; that is your decision.
- **Hours.** Every phase refuses from 15 minutes before the 01:00 and 05:00 UTC
  hours until they end (wildcard renewal, file cleanup), unless `--any-time`.
- **Traffic.** There is no real quiet time. Over a week of access logs in late
  October 2026 (requests, without health probes), the busiest hours were 16:00-20:00
  UTC at about 10% over the daily mean, and the quietest 00:00-02:00 and 04:00-06:00
  at about 10% under it. The busiest hour moved around from day to day, so pick a
  time for the jobs above, not for traffic. To measure it again, count requests per
  hour in `/var/instance-ssd/logs/access.log*`.

**Rollback** before the promotion: lift the freeze, `read-only.js off` in
`blot-blue` on the old host (`switch` does this itself when the lock wait
fails). After it, the old Redis replicates from the new one and both hosts
use the same bucket, so the way back is the switch in reverse, with nothing
to copy:

1. Freeze through the new host: `read-only.js on --ttl 900 --reason 'host cycle'`
   in `blot-blue` there, and wait for `lockedBlogs` in `read-only.js status`
   to be empty.
2. `config/redis/promote.sh <new> <old-redis>`.
3. On the old host: `docker start` the units, and wait until
   they are healthy. Nothing listens there until then, so moving the address
   first fails every read for that long (about 20 seconds in the rehearsal).
4. Move the Elastic IP back to the old instance with `aws ec2 associate-address`.
5. Lift the freeze with `read-only.js off` in `blot-blue` on the old host, and
   stop the new host's units.

This only works while the old units run the image the new host ran, so before
`settle` has resumed deploys, and while the old Redis still replicates (until
`finish`). After a move the address can reach the previous host for several
seconds, and an alias of it reports a changed host key until it has settled:
wait and retry, checking the key is the one you expect. `<new>` gets a new
public address when it loses the Elastic IP, so its alias needs that address
before you next use it.

### The wildcard certificate

`blue-green.sh` will not start a unit in fresh mode until
`/etc/ssl/private/letsencrypt-domain.pem` and `.key` exist and the `deploy` user
can read them. `wildcard-cert.sh` writes both from the wildcard certificate in
the host's own Redis (`blot:openresty:ssl:pem` and `:key`):

```
config/host/wildcard-cert.sh <ssh-host>
```

Run it after Redis on the new host has synced, since the keys come from that
Redis; it only reads, so a read-only replica is fine, and it is safe to re-run.
It copies itself to the host and runs there with sudo (`SSH_OPTS` works as in
`bootstrap.sh`). It refuses, leaving any existing files alone, if either value
is empty, the certificate has expired or the key is not the certificate's key.
Each file is written to a temp file in the same directory, then moved into
place as `root:deploy` mode `0640`, so the key is never world-readable. It never
prints the key. Run it before the first `deploy-units`.

## Recovery

Redis and both units share one host, so losing the host loses the app and its
Redis together. Blog folders and git repos are in S3 and outlive it.
`cycle.sh restore` rebuilds the rest from what is in AWS, in this order:

1. A new host, and Redis restored onto it from the newest backup (at most about
   an hour old; `restore.sh`, so `--offsite` works when AWS backups are gone).
2. The units, then the Elastic IP.

```
config/host/cycle.sh --production --type <type> [--root-gb N] --cycle <name> --eip <eipalloc-...> \
  --commit <sha> --secrets-env <file> --proxy-env <file> --aws-credentials <file> \
  [--offsite <profile> <s3://bucket>] [--redis-backup <name>] \
  [--bans-file data/bans.txt] [--yes] restore
```

There is no old host to read from, so you supply what is not in AWS or the repo,
all of it from your machine:

- `--secrets-env` and `--proxy-env`: `secrets.env` and `proxy.env` as they were
  on the lost host. Keep a copy of each off the host, updated whenever they
  change; nothing else has them. The socket settings are written in for you.
- `--aws-credentials`: a credentials file with a `[default]` profile that can
  read the Redis backups and write new ones. It becomes `~ec2-user/.aws` on the
  new host (a new host has no instance profile).
- `--commit`: the commit of the image to run. Run the script from a checkout of
  `master`, as `deploy-units` requires.
- `--eip`, and `--type`, `--root-gb` and `--cycle` as in `launch`.
- The host key pair and key (`BLOT_HOST_KEY_NAME`, `BLOT_HOST_SSH_KEY`,
  `BLOT_SSH_PORT`), the deploy public key, `REDIS_MAXMEMORY` and `AWS_PROFILE`
  and `AWS_REGION`, as for `launch`. The `blot` key is not on any host, so it
  comes from you.

Run it without a host name first: it launches the host and stops, printing the
ssh alias to add. Run the same command again with the alias on the end, and it
does the rest. Every step looks at the host and AWS to see what is done, so after
a failure fix the cause and run it again; `--dry-run` prints the steps, and each
step prints how long it took ("timing: ..."). It does not wait for the 01:00 and
05:00 UTC hours to pass.

The Elastic IP is the last step. In production the script stops and asks you to
type the ID of the instance that holds it now, whatever `--yes` says, because a
host may be unreachable rather than gone: stop it first if so, or two Redis
masters will diverge. It does not stop or touch that host. Only after the
address has moved does the host start backing up.

**Afterwards.** Redis is as of its backup, while the folders and repos in S3
kept every change since. Whatever Redis lost from that hour (entries, sync
state) disagrees with the folders until each blog syncs again: run sync
validation for the blogs, as in `config/redis/README.md` ("Disaster recovery",
step 6).

### What `restore` does not do

It does not set up the offsite backups (the Redis `offsite-bucket` file and its
`blot-b2` profile, and `/etc/blot/storage-offsite-bucket` and the
`blot-b2-storage` profile for the storage bucket's copy), and the permabans only
come back with `--bans-file`.

## Scripts and cron

- The wildcard certificate is not renewed from the host: the app's scheduler
  does it (`app/scheduler/renew-wildcard-ssl.js`) and the proxy reads it from
  Redis. A host built before then may still have the retired cron entry
  `/etc/cron.d/blot-wildcard-renewal`, `/etc/blot/wildcard-ssl-env.sh` and
  `/usr/local/bin/acme-nginx`; none of them is used any more.
- `check_docker_health.sh` restarts containers Docker reports as unhealthy. It
  is run from cron every minute as `/usr/local/bin/check_docker_health.sh`
  (`deploy.sh` copies it there, but does not install the cron entry; on a new
  host `host/setup.sh` does). It skips
  `blot-blue`, `blot-green` and `blot-<unit>-previous` (whole names) while a proxy deploy holds its lock, so it
  cannot restart the unit that is draining.
- Custom-domain certificates need nothing on the host: the proxy container
  renews them and refuses to serve an expired one (see `proxy/README.md`).
  `identify-expiring-certs.sh` and `purge-expired-ssl.sh`, which deleted
  certificates from Redis and restarted the proxy, are gone; remove any cron
  entry for them from the host.
- `mount-instance-store.sh` mounts the NVMe instance store at
  `/var/instance-ssd` (logs, cache and the app's tmp directory) at boot, and
  creates `/var/instance-ssd/tmp` for the app containers and
  `/var/instance-ssd/disk-cache` for the proxy's disk cache (both uid 1000), and
  `/var/instance-ssd/logs` (uid 1000, as the proxy container writes it) if it is
  missing, since a stop/start of the instance wipes the disk.
- The storage bucket's daily offsite copy to Backblaze B2
  ([`config/storage-bucket/README.md`](../storage-bucket/README.md), "Offsite
  backup and restore"). `host/setup.sh` installs `rclone` (from the Amazon
  Linux 2023 repository), the scripts in `config/storage-bucket/bin` at
  `/usr/local/lib/blot-storage/`, `blot-storage-offsite.service` (as
  `ec2-user`, `MemoryMax=2G`, `OOMPolicy=continue`, low CPU and IO priority, logging to
  `~ec2-user/storage-offsite.log`, rotated monthly by
  `/etc/logrotate.d/blot-storage-offsite`) and `blot-storage-offsite.timer`
  (daily at 02:10 UTC, enabled on every host). It does nothing until the host
  has `/etc/blot/storage-offsite-bucket` (one line, the B2 bucket's name) and
  the `blot-b2-storage` profile in `~ec2-user/.aws`, and is marked active
  (`/etc/blot-redis/active`). To put it on a running host, rerun
  `bootstrap.sh` (safe on a live host) or install the same files by hand.

## What the old bare-metal setup script did

`config/openresty/scripts/setup.sh` built the host when the proxy was bare-metal
OpenResty. It was deleted when `proxy/` became the canonical proxy config. The
host it built is still the host in production, so this is what it left behind
and what still depends on it. `deploy.sh` does not install any of it.

- Installed the `redis6` package (the host's `redis-cli`, which
  `proxy/deploy/common.sh` and `try-issuance.sh` need) and `nvme-cli` (used by
  `mount-instance-store.sh`).
- Installed `cronie` and wrote `/etc/cron.d/blot-wildcard-renewal`, which ran
  `renew-wildcard-ssl.sh` daily. That job moved into the app's scheduler, so a
  rebuilt host does not need the file.
- Wrote the wildcard certificate and key from Redis (`blot:openresty:ssl:pem`
  and `blot:openresty:ssl:key`) to `/etc/ssl/private/letsencrypt-domain.pem` and
  `.key`, the directory the proxy container mounts read-only. `wildcard-cert.sh`
  now does this on a rebuilt host (see
  [Moving to a new host](#moving-to-a-new-host)).
- Enabled and started `mount-instance-store.service`, and installed the
  `docker.service.d` drop-in that gates docker on `/var/instance-ssd` being
  mounted. `deploy.sh` installs both.

It also installed OpenResty, luarocks and `lua-resty-auto-ssl` on the host.
Bare-metal OpenResty was uninstalled on 8 Oct 2026 (packages, the `openresty`
systemd unit and its `openresty.service.d` drop-in, `/usr/local/openresty` and
`/etc/resty-auto-ssl`), so there is no host rollback. The auto-ssl state now
lives in the `blot-proxy-auto-ssl` Docker volume, and customer certificates in
Redis (`ssl:<domain>:latest`). To roll the proxy back, redeploy an older image:
`npm run deploy-units -- <older commit>`.
