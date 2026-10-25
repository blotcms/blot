# Deploying the proxy container

Production runs the proxy as a container (cut over from bare-metal OpenResty
on 8 Oct 2026, #1941; the bare-metal install has since been removed). Deploy a new image with the **Deploy proxy** workflow
(`.github/workflows/deploy-proxy.yml`, manual), or from a checkout:

```sh
npm run deploy-proxy             # master's tip, waiting for its image
npm run deploy-proxy -- <commit>
```

Both run [`scripts/deploy/proxy.sh`](../../scripts/deploy/proxy.sh), which
copies this directory to `~/proxy-deploy` on the host and runs
`blue-green.sh` there. The scripts below all run **on the production host**:

| Script | When |
| --- | --- |
| [`blue-green.sh`](blue-green.sh) | Every image change. Container to container, zero-downtime. With no proxy container running it starts the first one instead (no overlap, so a few seconds without a proxy if something else was serving). |
| [`try-issuance.sh`](try-issuance.sh) | Before an image change. Issues a Let's Encrypt **staging** certificate through the image for a throwaway domain, changing nothing that serves traffic. |
| [`reload-config.sh`](reload-config.sh) | Not for these containers: it needs the conf directory bind-mounted, which `blue-green.sh` does not do. Ship config changes as a new image. |

The scripts read the host's settings from `/etc/blot/proxy.env`
([`proxy.env.example`](proxy.env.example)) and share [`common.sh`](common.sh).
Paths default to the ones the bare-metal OpenResty used, which the host still has (`/var/instance-ssd/logs`,
`/etc/ssl/private`, and the `cdn.` static
directory `/var/www/blot/app/blog/static`), plus the cache directory
below (`/var/instance-ssd/disk-cache`),
so a redeploy keeps the warm cache and
the app's own `cdn.` files are served from disk (with the `Cache-Control`/CORS headers of
`location /`) instead of falling through to Node. Per-blog assets are not on
the host: they live in the storage bucket, which the CDN fetches from directly
and the app serves as a fallback. Containers also get
`--ulimit nofile=65536:65536` (`PROXY_NOFILE`) - headroom above both the
~20000 fds `worker_connections 10000` can need (two fds per proxied
connection) and the config's own `worker_rlimit_nofile 20480`
(`proxy/config/initial.conf`).
`bash tests/run.sh` exercises both scripts against fake `docker`/`systemctl` (CI runs it), and the `proxy-deploy-e2e` workflow runs `blue-green.sh` against real Docker ([`e2e/`](e2e/README.md)).

## Setting up a host

1. **An image.** `.github/workflows/proxy-image.yml` publishes
   `ghcr.io/blotcms/blot-proxy:<sha>` (multi-arch, built with
   `LOG_TO_STDOUT=false` because `fail2ban`, `logrotate` and the `.bashrc`
   helpers read `/var/instance-ssd/logs/access.log` and the container has no
   ban layer of its own; `blue-green.sh` refuses an image that logs to stdout).
   It builds every push to master. Pass the SHA to a script;
   anything containing `/` or `:` is used as a full image reference.
2. **`/etc/blot/proxy.env`** from the example. `PROXY_UPSTREAM_*` should be the Node containers' `unix:/run/blot/<colour>.sock`
   sockets (the example shows them); the scripts then mount `/run/blot` into the
   proxy and check each socket before and after the swap. `PROXY_PRIVATE_IP` and
   `PROXY_REDIS_HOST` (both required, the scripts refuse empty values) must be the host's private IP and Redis host, and `BLOT_REVERSE_PROXY_URLS`
   in `/etc/blot/secrets.env` must point at `http://<PROXY_PRIVATE_IP>:8077`,
   because Node purges the cache from a Docker bridge that cannot see the
   host's `127.0.0.1`. The scripts read the value from the running Node
   container, so recreate the Node containers (a normal deploy) after editing it.
   GitHub's Deploy proxy workflow runs the scripts as the `deploy` user, which
   must be able to read the file. It can hold `BLOT_PURGE_TOKEN`, so grant that
   user an ACL rather than making it world-readable:
   `sudo setfacl -m u:deploy:r /etc/blot/proxy.env`
   ([`setup-deploy-user.sh`](../../scripts/deploy/setup-deploy-user.sh) does this if the file already exists).
3. **The wildcard certificate** is renewed by the app's scheduler
   (`app/scheduler/renew-wildcard-ssl.js`), not from the host. The proxy
   serves it from Redis (within seconds of a renewal, no reload needed; see
   [`../README.md`](../README.md)) and uses the file only as a fallback.
4. Optionally run the scripts with `PROXY_CUSTOM_DOMAIN=<a real custom domain>` set:
   it adds a domain whose certificate comes from Redis to every before/after
   comparison. This is in addition to the sweep below, which always runs.
5. `redis-cli` must be on the host.

## Custom-domain certificates

Custom domains are not among the checked hosts and their certificates come from
Redis, not the wildcard file, so a container that could not read or serve them
would pass every other check. `blue-green.sh` therefore records the certificate the
running proxy presents for **every** `ssl:<domain>:latest` key in Redis (looked
up by SNI on `127.0.0.1`), and requires every one to be unchanged on the
real ports after the swap (it rolls back if one differs). A domain that
presented no certificate beforehand is not held against the replacement. A
certificate that legitimately renews in the seconds between the two sweeps
would fail the check; rerun the script.

On a **fresh start** there is no running proxy to compare with, so instead the
new container must present a certificate for every custom domain in Redis
before it is made permanent; the first few domains without one are listed. A
Redis with no custom domains passes.

A domain whose stored certificate has expired is left out of both checks: the
proxy treats an expired certificate as missing, so the replacement not
presenting it is expected.

The script refuses to go on if `redis-cli` is missing, or (on a swap) no
certificate could be read from the running proxy. `PROXY_SKIP_CERT_SWEEP=1`
skips both the comparison and the fresh-start check.

## Cache directory

Every image keeps its cache (`diskcache.lua`) in one host directory,
`/var/instance-ssd/disk-cache` (`PROXY_DISK_CACHE_DIR`), which `blue-green.sh`
mounts at `/var/cache/openresty`. It must exist and belong to uid 1000
(`mount-instance-store.sh` creates it at boot; otherwise
`sudo install -d -o 1000 -g 1000 <dir>`).

- A swap touches nothing and keeps the warm cache. The old and the new colour
  share the directory, so a purge reaching either one purges both, and a swap
  that fails after the old container was stopped needs no cleanup before it
  is started again.
- On a fresh start (nothing running) the directory is emptied **before** the
  container starts, since it missed every purge since it was last in use. The
  files belong to uid 1000 and the deploy user has no sudo, so a container does
  it: it moves every top-level entry into `.trash/<timestamp>/` (instant: a
  cache has a few shard directories) and deletes that in a detached container,
  so the deploy does not wait for millions of files to go.

## Trying issuance against a real ACME server

The sweep above covers certificates that already exist. For *issuing*, CI can
only use Pebble, so run this once per new image, before deploying it:

```sh
~/proxy-deploy/try-issuance.sh <commit-sha> <throwaway-domain>
```

The domain must be one nobody uses (a subdomain of one you own is fine, not
under `BLOT_HOST`), with DNS pointing at this host. The script starts the image
on `127.0.0.1:18444` with `PROXY_ACME_CA` set to Let's Encrypt staging (its own
auto-ssl volume; no cache or logs), allows the domain in Redis, makes a TLS
request for it and waits for a staging-issued certificate. Let's Encrypt's
HTTP-01 request lands on whichever proxy is serving `:80`: lua-resty-auto-ssl
keeps challenge tokens in Redis, so the serving proxy can answer for the
throwaway container. It removes `domain:<domain>`, the staging certificate and
the container when it finishes, and refuses a domain Redis already knows.

The deploy scripts refuse a `PROXY_ACME_CA` other than Let's Encrypt production
in `proxy.env` (`PROXY_ALLOW_ACME_CA=1` overrides), so a staging directory
cannot be left behind and start issuing certificates no browser trusts.

*Renewal* is still untested: nothing yet exercises dehydrated 0.7.2 renewing a
certificate.

## First container, and rolling back

Production moved from the bare-metal `openresty` systemd unit to the first
container on 8 Oct 2026 (#1941), using a one-off script that rehearsed the
image on another port, stopped bare-metal, started the container and rolled
back on any failed check. That script is deleted, and the bare-metal install
has since been removed from the host.

On a host with no proxy container running (a rebuilt host, or after the
container was removed), `blue-green.sh` starts the first one. It also refuses
while a legacy `openresty` systemd unit is active or enabled, which would
conflict with the container for `:80`/`:443`.

To roll back, redeploy an older image:

```sh
npm run deploy-proxy -- <older-commit>
```

or run the Deploy proxy workflow with that commit.

## Known gaps

- **`:8999` ACME hook** during the overlap (see the root `TODO`).
- The container has no `fail2ban` of its own; it relies on the host's reading
  the shared log directory (hence the log-mode guard above).
