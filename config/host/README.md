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

## What it installs

| Here | On the host |
| --- | --- |
| `scripts/` (all of it, replacing the old directory) | `/home/ec2-user/scripts/` |
| `scripts/mount-instance-store.service` | `/etc/systemd/system/mount-instance-store.service` |
| `scripts/docker.service.d/10-instance-store.conf` | `/etc/systemd/system/docker.service.d/10-instance-store.conf` |
| `scripts/mount-data-volume.service` | `/etc/systemd/system/mount-data-volume.service` |
| `scripts/docker.service.d/20-data-volume.conf` | `/etc/systemd/system/docker.service.d/20-data-volume.conf` |
| `fail2ban/filter.d/*.conf`, `fail2ban/jail.local`, `fail2ban/fail2ban.local` | `/etc/fail2ban/` (then restarts fail2ban) |
| `logrotate/*` | `/etc/logrotate.d/` |
| `tmpfiles.d/blot.conf` | `/etc/tmpfiles.d/blot.conf` (creates `/run/blot`) |
| `.bashrc` | `/home/ec2-user/.bashrc` |

The `nginx-*` fail2ban jails ban `http,https` over TCP and, with a second
`iptables-multiport` action named `<jail>-udp`, over UDP too (HTTP/3 is UDP 443).
They deliberately do not use `iptables-allports`, which would also lock a
banned IP out of ssh.

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

There is no bootstrap script: the host was built by hand (the old setup script
is described at the end of this file), and `deploy.sh` only installs the files
in the table above onto a host that already exists. This is the state that
lives on the host and has to be carried across or recreated. Do it before
pointing traffic at the new host.

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
- **`/etc/blot/data-volume`** and the `.blot-data-volume` marker on the data
  volume (see above).
- **Wildcard certificate** files in `/etc/ssl/private/` (`letsencrypt-domain.pem`
  and `.key`), written from Redis; `blue-green.sh` won't start a proxy
  container without them.
- **Packages and cron:** `redis6` (for `redis-cli`), `nvme-cli`, `cronie`, and
  the cron entry that runs `check_docker_health.sh` every minute (`deploy.sh`
  copies the script but not the entry).
- Then `npm run deploy-host` and the Deploy workflow.

Nothing in `proxy/` or the units needs copying: custom-domain
certificates are in Redis and the proxy cache refills itself.

It also turns off X11 forwarding in `sshd_config`. The systemd files are
installed and `daemon-reload`ed only: docker is not restarted, so the
mount-before-docker ordering takes effect at the next reboot.

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
device and writes both files; it never overwrites them afterwards. If there is
neither the file nor a mounted volume it warns and leaves the unit disabled.
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
  (`deploy.sh` copies it there, but does not install the cron entry). It skips
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
  `/var/instance-ssd/disk-cache` for the proxy's disk cache (both uid 1000), since a
  stop/start of the instance wipes the disk.
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
