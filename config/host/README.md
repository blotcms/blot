# Proxy host setup

Setup for the production proxy host (the EC2 instance that runs the two units,
`blot-blue` and `blot-green`: OpenResty and Node in one container each). The proxy itself is not installed from
here: deploy it with `npm run deploy-units` or the Deploy workflow (see
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
| `scripts/mount-data-volume.service` | `/etc/systemd/system/mount-data-volume.service` |
| `scripts/docker.service.d/20-data-volume.conf` | `/etc/systemd/system/docker.service.d/20-data-volume.conf` |
| `fail2ban/filter.d/*.conf`, `fail2ban/jail.local`, `fail2ban/fail2ban.local` | `/etc/fail2ban/` (then creates any `logpath` in `jail.local` that is missing and restarts fail2ban) |
| `scripts/fail2ban.service.d/10-instance-store.conf` | `/etc/systemd/system/fail2ban.service.d/10-instance-store.conf` |
| (written by `deploy.sh`) | `X11Forwarding no` in `/etc/ssh/sshd_config`, and on Amazon Linux 2023 in `/etc/ssh/sshd_config.d/12-blot-x11.conf` |
| `logrotate/*` | `/etc/logrotate.d/` |
| `tmpfiles.d/blot.conf` | `/etc/tmpfiles.d/blot.conf` (creates `/run/blot`) |
| `.bashrc` | `/home/ec2-user/.bashrc` (must print nothing to stdout in a non-interactive shell: scp is SFTP on Amazon Linux 2023) |

The `nginx-*` fail2ban jails ban `http,https` over TCP and, with a second
`iptables-multiport` action named `<jail>-udp`, over UDP too (HTTP/3 is UDP 443).
They deliberately do not use `iptables-allports`, which would also lock a
banned IP out of ssh.

## Unit memory log

`unit-mem-log.sh` appends to `/var/instance-ssd/logs/unit-mem.log` (instance
store, so it survives deploys; about 30 days are kept). Each cron run takes four
samples 15 seconds apart. Per sample there is one line per container
(`blot-blue`, `blot-green` and their airlocks) with `anon`, `file`, `shmem`,
`limit` and `oom_kill` from the container's cgroup (v1 or v2), `node_max` (the
biggest node process) and `top=comm:bytes` (the biggest non-node process, i.e. a
pandoc/git/exiftool spike), `peak` (the cgroup's high-water mark, v2 only), and
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
app and Redis security groups, IMDSv2 only, a 200 GB gp3 root, termination
protection on) and runs `bootstrap.sh` on it. `--ssh-port` goes in user data, so
the first connection already uses that port. `--redis-maxmemory` (or
`REDIS_MAXMEMORY`) is required and has no default: the Redis setup's 70% of RAM
is wrong on a host the units share. Afterwards it checks from your machine
that port 6379 is not reachable on the host's public address, and if it is it
stops and says the instance is still running. It attaches no data volume,
moves no Elastic IP and starts no replication; it ends by printing the
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
  25 and 1.5 CPUs. Those wait for `BLOT_SANDBOX_BROWSER=1`;
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
- **The data volume.** Attach it, then run `deploy.sh` again with
  `DATA_VOLUME_ID=vol-...`, which writes `/etc/blot/data-volume`. Don't set it
  before the volume is attached: the unit waits for the device, then fails the
  run. A volume restored from a snapshot still
  carries the old volume's ID in `.blot-data-volume`; mount it once by hand and
  write the new ID there before the unit mounts it (see below).
- **Wildcard certificate** files in `/etc/ssl/private/` (`letsencrypt-domain.pem`
  and `.key`), written from Redis; `blue-green.sh` won't start a proxy
  container without them.
- Then `deploy.sh` and the Deploy workflow. docker is enabled but
  stays stopped until the instance store and the data volume are mounted.

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

The data volume (the EBS volume at `/var/www/blot/data`) is mounted at boot by
`mount-data-volume.service`, and the drop-in gates docker on it the same way.
Which volume belongs there is host state, not repo state, because the volume
changes whenever it is swapped for a resized or restored one:

- `/etc/blot/data-volume` holds the expected EBS volume ID on one line (e.g.
  `vol-0a2e04d301e025e60`). `mount-data-volume.sh` reads it, waits for the
  matching `/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_vol...` device,
  mounts it, and refuses to carry on if a different device is already mounted
  there.
- `.blot-data-volume` at the root of the volume holds the same ID.
  `mount-data-volume.sh` unmounts and fails if it is missing or doesn't match,
  and the deploy's verify step fails a container that can't see it (a
  container started against an empty directory on the root disk). Put it on a
  replacement volume before swapping it in.

On the first run against a host with the volume already mounted (and no
`/etc/blot/data-volume`), `deploy.sh` works out the volume ID from the mounted
device and writes both files; it never overwrites them afterwards. With
`DATA_VOLUME_ID` set (`vol-` and 8 to 17 hex digits) and no
`/etc/blot/data-volume`, it writes that ID instead; if a different volume is
mounted it stops without writing anything, and it writes the marker only for the
volume that is mounted. If there is neither the file nor a mounted volume it
warns and leaves the unit disabled.
`mount-data-volume.sh` also makes the mount `shared`, which the app
containers' `bind-propagation=rslave` bind of the data directory needs, so a
volume mounted on the host over `/var/www/blot/data` reaches running
containers without a restart. `deploy.sh` also removes the legacy
`mount-data-disk.service` (its script no longer exists on the host).

The install paths are load-bearing: `mount-instance-store.service` hardcodes
`/home/ec2-user/scripts/mount-instance-store.sh` (likewise
`mount-data-volume.service` and `mount-data-volume.sh`).

## Host cycle

`cycle.sh` moves everything onto a fresh host, so upgrades and resizes mean
building a new host rather than patching one. It wraps the scripts above,
`data-volume/resize.sh`, `config/redis/promote.sh` and `scripts/deploy/units.sh`,
and adds little of its own (see the usage at the top of the file). Rehearse it
with `--drill` on hosts tagged `BlotDrill=true`.

```
config/host/cycle.sh --production --type m6gd.xlarge --cycle <name> launch <old>
config/host/cycle.sh --production [--old-redis <host>] replicate <old> <new>
config/host/cycle.sh --production data <old> <new>
config/host/cycle.sh --production [--old-redis <host>] app <old> <new>
config/host/cycle.sh --production --eip <id> --bans-file data/bans.txt --old-direct <host> [--old-redis <host>] switch <old> <new>
config/host/cycle.sh --production --eip <id> --old-direct <host> settle <old> <new>
config/host/cycle.sh --production --eip <id> --old-volume <vol> --old-instance <id> finish <old> <new>
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
- **Two hosts.** With a separate Redis host pass `--old-redis`, also for later
  phases that promote. Without it `<old>` is taken to run Redis too.
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
- **The freeze.** `switch` re-arms the freeze's TTL (`--freeze-ttl`, default 900
  seconds) between steps, through whichever host has the Redis master, and
  lifts it through the new host. It keeps the old host's disk read-only, the old
  units stopped but not removed, and its Redis a replica of the new one.
- **`settle`** forces a rolling deploy of the same image, because a plain one
  skips units already on it, and that restart is what runs the steps that failed
  on the replica. It then retags the volumes: a rollback is simplest before that.
- **`finish`** terminates only the instances named with `--old-instance`, and
  not within 3 days of `settle` (`--any-age`). It stops at termination
  protection and prints the command that lifts it; that is your decision. The
  old data volume is kept, for you to delete.
- **Hours.** Every phase refuses from 15 minutes before the 01:00 and 05:00 UTC
  hours until they end (wildcard renewal, file cleanup), unless `--any-time`.

**Rollback** before the promotion: `resize.sh --host <old> move thaw`. After it,
the short path is only for a switch that has accepted no writes (the new host
was frozen the whole time, so nothing on it is newer than the old volume):

1. `config/redis/promote.sh <new> <old-redis>`.
2. On the old host: `docker start` the airlocks and the units, and wait until
   they are healthy. Nothing listens there until then, so moving the address
   first fails every read for that long (about 20 seconds in the rehearsal).
3. Move the Elastic IP back to the old instance with `aws ec2 associate-address`.
4. `resize.sh --host <old> move thaw`.

After a move the address can reach the previous host for several seconds, and
an alias of it reports a changed host key until it has settled: wait and retry,
checking the key is the one you expect. `<new>` gets a new public address when
it loses the Elastic IP, so its alias needs that address before you next use it.

Once the new host has accepted writes, the old volume is behind, so promoting
Redis or moving the Elastic IP first would send traffic to stale files. Follow
the order in `data-volume/README.md` ("Rollback", after the switch) and decide
quickly:

1. On the old host: `resize.sh --host <old> move thaw`. The switch left its
   data directory read-only, and `move prepare --to <old> --existing` refuses a
   read-only target. Its units stay stopped, so nothing writes to it yet; the
   new host stays primary with the Elastic IP.
2. Copy back what changed, with the hosts swapped:
   `resize.sh --host <new> move prepare --to <old> --existing`, then `copy` and
   `freeze` (this needs `settle` not to have retagged yet). The freeze stops
   writes on the new host once the final copy is done; leave it frozen.
3. Then `config/redis/promote.sh <new> <old-redis>`.
4. On the old host: `docker start` the airlocks and the units, and wait until
   they are healthy.
5. Then the Elastic IP back to the old instance.
6. Lift the app freeze with `read-only.js off` in `blot-blue` on the old host.
   Its disk was thawed in step 1, so there is no second thaw; do not thaw the
   new host either, and stop its units.

The rehearsal took about 4.5 minutes from thaw to writes back, with writes
down for about 3 of them: the final copy, the promotion and the units' start.

To go forward again after that, `resize.sh --host <new> move thaw`, then remove
what the reverse move left, or `move prepare` refuses: on `<new>`
`/etc/blot/data-volume-resize.state` and `/etc/blot/data-move-key*` and
`data-move-known-hosts`, and on the old host the `blot-data-move` line in
`ec2-user`'s `authorized_keys`. Then run `data`, `app` and `switch` as before.
The `data` copy finds only the difference, seconds on the rehearsal's volume.

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
Redis together. `cycle.sh restore` rebuilds from what is in AWS, in this order:

1. A new host, and Redis restored onto it from the newest backup (at most about
   an hour old; `restore.sh`, so `--offsite` works when AWS backups are gone).
2. A new data volume from the newest completed snapshot of the lost volume. The
   lost volume is only named, to find its snapshots. It is never attached,
   detached or changed, so anything newer than the snapshot can still be
   recovered from it.
3. The units, then the Elastic IP.
4. Reconcile (below).

The snapshot is older than Redis, so Redis can name files the volume does not
have. Step 4 is what repairs that.

```
config/host/cycle.sh --production --type <type> --cycle <name> --eip <eipalloc-...> \
  --old-volume <vol-...> --commit <sha> \
  --secrets-env <file> --proxy-env <file> --aws-credentials <file> \
  [--offsite <profile> <s3://bucket>] [--redis-backup <name>] [--snapshot <snap-...>] \
  [--bans-file data/bans.txt] [--wait-prewarm] [--yes] restore
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
- `--old-volume`, or `--snapshot` to pick one yourself. `--eip`, and `--type`
  and `--cycle` as in `launch`.
- The host key pair and key (`BLOT_HOST_KEY_NAME`, `BLOT_HOST_SSH_KEY`,
  `BLOT_SSH_PORT`), the deploy public key, `REDIS_MAXMEMORY` and `AWS_PROFILE`
  and `AWS_REGION`, as for `launch`. The `blot` key is not on any host, so it
  comes from you.

Run it without a host name first: it launches the host and stops, printing the
ssh alias to add. Run the same command again with the alias on the end, and it
does the rest. Every step looks at the host and AWS to see what is done, so after
a failure fix the cause and run it again; `--dry-run` prints the steps. It does
not wait for the 01:00 and 05:00 UTC hours to pass.

The Elastic IP is the last step. In production the script stops and asks you to
type the ID of the instance that holds it now, whatever `--yes` says, because a
host may be unreachable rather than gone: stop it first if so, or two Redis
masters will diverge. It does not stop or touch that host. Only after the
address has moved does the new volume get the name the snapshot policy targets,
and the host start backing up. The old volume keeps its own tags; retag it when
the reconcile is done.

**How slow it is.** A volume made from a snapshot loads from S3 as it is read, so
reads are slow until it has been read once. The script starts the same low
priority pre-warm `resize.sh move` uses before the units start, and prints how
long each step took ("timing: ..."), plus three cold 256 MiB reads straight from
the device before the pre-warm touches it. `--wait-prewarm` holds the address
back until the pre-warm has finished; without it the site comes up on a cold
volume. A rehearsal (`--drill`, with a drill Elastic IP and the `BlotDrill=true`
tag on everything) is where to record both numbers.

### Reconcile

```
ssh <new> sudo docker exec --user 1000:1000 -e HOME=/home/node blot-blue node scripts/host-cycle/reconcile.js --since <snapshot start>
```

`restore` prints the command with the snapshot's start time. Without `--go` it
only prints a plan:

- **Which blogs.** Dropbox, Google Drive and iCloud blogs whose `cacheID` is at
  or after `--since` (less `--margin`, 15 minutes), plus any with no `cacheID`.
  A blog's `cacheID` is set when a sync changes something, so it is the time
  of the last change Redis knows about; it is also set by template and setting
  changes, which only costs a resync that was not needed. `--all` skips the
  filter. Blogs of the same client run at most one at a time (`--per-client`),
  and two at once overall (`--concurrency`), with `--pause` seconds after each,
  because the clients' APIs have limits. A resync takes the blog's normal sync
  lock, so it cannot race a live sync; one that cannot get the lock is left for
  the next run.
- **Order.** Most recently changed first.
- **Git blogs** have no source to resync from. The plan lists their IDs and
  last change instead. Whatever was pushed after the snapshot is only on the old
  volume, unless its author pushes again.
- **Resuming.** Finished blogs go in `reconcile-state.txt` in the data
  directory, tied to `--since`. Run it again after a failure and it skips them;
  `--restart` forgets them.

It prints IDs and counts only.

### What `restore` does not do

It does not set up the offsite backup (the `offsite-bucket` file and its B2
profile), and the permabans only come back with `--bans-file`. It does not move
anything off the old volume: recover newer files from it by hand, with it
attached read-only to a scratch host.

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
  `blot-blue`, `blot-green` and `blot-<unit>-previous` (whole names, so the
  airlocks are still restarted) while a proxy deploy holds its lock, so it
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
- `mount-data-volume.sh` mounts the EBS data volume at `/var/www/blot/data` at
  boot (see above).

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
