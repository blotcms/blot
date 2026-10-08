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
`/home/ec2-user/scripts/renew-wildcard-ssl.sh`, and
`proxy/deploy/cutover-from-baremetal.sh` looks for the helpers there.

## Scripts and cron

- `renew-wildcard-ssl.sh` renews the wildcard certificate, writes it to Redis
  and reloads the proxy. It reads `/etc/blot/wildcard-ssl-env.sh` on the host.
  It runs daily from `/etc/cron.d/blot-wildcard-renewal` (`0 1 * * * root
  /home/ec2-user/scripts/renew-wildcard-ssl.sh >> /home/ec2-user/renew-wildcard.log`),
  which was written by `config/openresty/scripts/setup.sh` when the host was
  built, not by `deploy.sh`.
- `check_docker_health.sh` restarts containers Docker reports as unhealthy. It
  is run from cron every minute (see its header); `deploy.sh` does not install
  that entry.
- `identify-expiring-certs.sh` and `purge-expired-ssl.sh` are run by hand to
  find and drop custom-domain certificates (see
  `app/helper/email/admin/SSL_CERTIFICATE_ISSUES.txt`).
- `mount-instance-store.sh` mounts the NVMe instance store at
  `/var/instance-ssd` (logs and cache) at boot.
