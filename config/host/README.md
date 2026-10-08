# Proxy host setup

Setup for the production proxy host (the EC2 instance that runs the proxy
container and the Node containers). The proxy itself is not installed from
here: deploy it with `npm run deploy-proxy` or the Deploy proxy workflow (see
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
| `fail2ban/filter.d/*.conf`, `fail2ban/jail.local` | `/etc/fail2ban/` (then restarts fail2ban) |
| `logrotate/*` | `/etc/logrotate.d/` |
| `.bashrc` | `/home/ec2-user/.bashrc` |

It also turns off X11 forwarding in `sshd_config`. The systemd files are
installed and `daemon-reload`ed only: docker is not restarted, so the
mount-before-docker ordering takes effect at the next reboot.

The install paths are load-bearing: `mount-instance-store.service` hardcodes
`/home/ec2-user/scripts/mount-instance-store.sh`, cron calls
`/home/ec2-user/scripts/renew-wildcard-ssl.sh`.

## Scripts and cron

- `renew-wildcard-ssl.sh` renews the wildcard certificate, writes it to Redis
  and reloads the proxy. It reads `/etc/blot/wildcard-ssl-env.sh` on the host.
  It runs daily from `/etc/cron.d/blot-wildcard-renewal` (`0 1 * * * root
  /home/ec2-user/scripts/renew-wildcard-ssl.sh >> /home/ec2-user/renew-wildcard.log`),
  which was written by the bare-metal `setup.sh` when the host was built (see
  below), not by `deploy.sh`.
- `check_docker_health.sh` restarts containers Docker reports as unhealthy. It
  is run from cron every minute (see its header); `deploy.sh` does not install
  that entry.
- `identify-expiring-certs.sh` and `purge-expired-ssl.sh` are run by hand to
  find and drop custom-domain certificates (see
  `app/helper/email/admin/SSL_CERTIFICATE_ISSUES.txt`).
- `mount-instance-store.sh` mounts the NVMe instance store at
  `/var/instance-ssd` (logs and cache) at boot.

## What the old bare-metal setup script did

`config/openresty/scripts/setup.sh` built the host when the proxy was bare-metal
OpenResty. It was deleted when `proxy/` became the canonical proxy config, but
the host it built is still the host in production, so this is what it left
behind and what still depends on it. `deploy.sh` does not install any of it.

- Installed the `redis6` package (the host's `redis-cli`, which
  `proxy/deploy/common.sh` and `try-issuance.sh` need) and `nvme-cli` (used by
  `mount-instance-store.sh`).
- Installed `cronie` and wrote `/etc/cron.d/blot-wildcard-renewal`, which runs
  `/home/ec2-user/scripts/renew-wildcard-ssl.sh` daily at 01:00 as root, logging
  to `/home/ec2-user/renew-wildcard.log`. **The container host still relies on
  this**: nothing else renews the wildcard certificate, so a rebuilt host needs
  `cronie` running and that file recreated by hand.
- Wrote the wildcard certificate and key from Redis (`blot:openresty:ssl:pem`
  and `blot:openresty:ssl:key`) to `/etc/ssl/private/letsencrypt-domain.pem` and
  `.key`, the directory the proxy container mounts read-only. On a rebuilt host
  these must exist before `blue-green.sh` will start a container.
- Enabled and started `mount-instance-store.service`, and installed the
  `docker.service.d` drop-in (and an `openresty.service.d` one) that gate those
  units on `/var/instance-ssd` being mounted. `deploy.sh` installs the
  `mount-instance-store.service` and `docker.service.d` files.
- Installed OpenResty (yum repo `openresty.org`), luarocks and
  `lua-resty-auto-ssl`, created `/etc/resty-auto-ssl`, and pointed
  `/usr/local/openresty/nginx/conf/nginx.conf` at
  `/home/ec2-user/openresty/openresty.conf`. All of that has since been
  uninstalled from the production host; a rebuilt host does not need it, since
  the proxy runs from the container image.
