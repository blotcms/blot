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
On a new host also set `DATA_VOLUME_ID` (see [Moving to a new host](#moving-to-a-new-host)).

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
pandoc/git/exiftool spike), and one `name=host` line with `mem_available`.
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
the public history.

```
sudo fail2ban-client set manual-permaban banip 203.0.113.0/24      # add
sudo fail2ban-client set manual-permaban unbanip 203.0.113.0/24    # remove
sudo fail2ban-client status manual-permaban                        # list
```

Moving to a new host: see [Moving to a new host](#moving-to-a-new-host).

## Moving to a new host

A new host is built on Amazon Linux 2023 (arm64). `bootstrap.sh` does the
root-side OS setup, then `deploy.sh` installs the files in the table above onto
it. The rest is state that lives on the host and has to be carried across or
recreated. Do it before pointing traffic at the new host.

```
BLOT_SSH_PORT=... BLOT_DEPLOY_PUBLIC_KEY="ssh-..." config/host/bootstrap.sh <ssh-host>
```

It copies `host/` and `scripts/deploy/setup-deploy-user.sh` to the host and
runs `host/setup.sh` with sudo; both variables are optional and `SSH_OPTS`
works as in `config/redis/bootstrap.sh`. `setup.sh` refuses to run anywhere but
Amazon Linux 2023, is safe to re-run, and never starts or restarts docker or
upgrades a package. It:

- installs `docker`, `fail2ban-server`, `iptables-nft`, `rsyslog`, `cronie`,
  `chrony`, `rsync`, `xfsprogs`, `nvme-cli`, `redis6` and `logrotate`, and links
  `redis6-cli` as `/usr/local/bin/redis-cli`;
- enables docker without starting it, checks cgroup v2, and adds a drop-in that
  orders docker after `redis6.service`; `ec2-user` joins the `docker` group;
- creates the `deploy` user (`scripts/deploy/setup-deploy-user.sh`);
- with `BLOT_SSH_PORT`, sets sshd's port in `/etc/ssh/sshd_config.d/11-blot-port.conf`
  (sshd then listens on that port only);
- installs the `check_docker_health.sh` cron entry, enables `crond`, `rsyslog`,
  `chronyd` and `fail2ban` (the last is started by `deploy.sh`), creates
  `/var/www/blot/data` and `/var/www/blot/app/blog/static`, and sets
  `net.ipv4.tcp_migrate_req = 1`.

`config/host/tests/setup.sh` runs it in Docker, and `config/host/tests/deploy.sh`
runs `deploy.sh` on top of it. Still by hand:

- **Permanent bans** (`manual-permaban`). The only fail2ban state worth keeping;
  the nginx jails' bans last 30-60 minutes and `recidive` a week. On the old
  host, list them, then on the new host (after `npm run deploy-host`) re-add
  each one:

  ```
  sudo fail2ban-client status manual-permaban     # old host: "Banned IP list"
  sudo fail2ban-client set manual-permaban banip <ip-or-cidr>   # new host, each
  ```

  Copying `/var/lib/fail2ban/fail2ban.sqlite3` also works, but fail2ban holds it
  open: stop fail2ban on the old host first (or use `sqlite3 <db> ".backup
  <copy>"`), put it in place on the new host before fail2ban first starts, and
  keep the same fail2ban version. Re-running `banip` is simpler and doesn't
  depend on either.
- **The data volume.** Attach it, then run `DATA_VOLUME_ID=vol-... npm run deploy-host`:
  that writes `/etc/blot/data-volume`. A volume restored from a snapshot still
  carries the old volume's ID in `.blot-data-volume`; mount it once by hand and
  write the new ID there before the unit mounts it (see below).
- **Wildcard certificate** files in `/etc/ssl/private/` (`letsencrypt-domain.pem`
  and `.key`), written from Redis; `blue-green.sh` won't start a proxy
  container without them.
- Then `npm run deploy-host` and the Deploy workflow. docker is enabled but
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
  `.key`, the directory the proxy container mounts read-only. On a rebuilt host
  these must exist before `blue-green.sh` will start a container.
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
