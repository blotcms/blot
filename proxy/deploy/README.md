# Deploying the units

Production runs two units, `blot-blue` and `blot-green` (#2119): each one
container holding OpenResty and the Node app (node-a, and node-b which it forks),
built from the `unit` target of the root Dockerfile (`ghcr.io/blotcms/blot`, labelled `im.blot.kind=unit`).
Before them the containers held OpenResty alone, in front of the
`blot-container-*` Node containers (the proxy has been a container since
8 Oct 2026, #1941). Deploy a new image with the **Deploy** workflow
(`.github/workflows/deploy.yml`, manual), or from a checkout:

```sh
npm run deploy-units             # master's tip, waiting for its image
npm run deploy-units -- <commit>
```

Both run [`scripts/deploy/units.sh`](../../scripts/deploy/units.sh), which
copies this directory to `~/proxy-deploy` on the host and runs
`blue-green.sh` there. The scripts below all run **on the production host**:

| Script | When |
| --- | --- |
| [`blue-green.sh`](blue-green.sh) | Every image change. Replaces the two always-running proxies, `blot-blue` then `blot-green`, one at a time while the other carries the traffic (see "Two proxies" below). Moves a host with the single proxy of before (`blot-proxy-blue`/`blot-proxy-green`) to the two, and starts both on a host with no proxy (no overlap, so a few seconds without a proxy if something else was serving). |
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

## Units, and the cutover

`blue-green.sh` deploys a unit image the way it deploys a proxy image (the
sections below describe the flow) and adds, for a unit:

- the Node containers' arguments: `/etc/blot/secrets.env` then `proxy.env` as
  env files (a key set differently in the two is refused before anything is
  touched), `BLOT_UNIT`, the data directory with `rslave`, the tmp directory,
  `/run/blot`, `BLOT_RELEASE_ID`, `NODE_OPTIONS` (node-a's heap and the crash
  report) and `BLOT_WORKER_MAX_OLD_SPACE_SIZE` (node-b), the memory and cpu
  limits, `--stop-timeout`. The numbers are in `scripts/deploy/constants.js`
  (`UNIT`), which `scripts/deploy/units.sh` writes to `unit-settings.env` beside
  these scripts;
- no TCP port: node-a serves on its socket alone (two units on the host network
  would both want 8080), so everything talks to the sockets;
- its own airlock, `blot-<unit>-airlock`, replaced just before the unit and
  published on 127.0.0.1 at the unit's own ports (a unit on the host network
  cannot join `blotnet`; see `config/airlock/README.md`);
- health: the proxy's health socket, node-a and node-b `/health` on their sockets;
- blue, deployed first, runs `scripts/deploy/verify-container` before green is
  touched; a failure rolls blue back and leaves green alone;
- at the end, the old Node containers and `blot-airlock` are stopped if they are
  running.

**The cutover is the first run of a unit image.** Production starts with
proxy-only `blot-blue` and `blot-green` and the running `blot-container-blue`,
`-green` and `-yellow` and `blot-airlock`. The run replaces blue with a unit
(green, still proxy-only, keeps routing to the old Node containers, which the
checks go on requiring while it does; the new blue's backups, green's sockets,
do not exist yet, which is fine), checks it, runs the canary, then replaces
green the same way (a proxy-only peer counts as healthy for the "other unit must
be healthy" rule). Only when both are healthy units and the checks pass are the
old containers stopped with `docker stop --time 40` (a unit's stop timeout), stopped and not removed. A
run that is cut off can simply be run again: a unit already on the image is
skipped, and the stop step does nothing once the old containers are stopped.

### Rolling back the cutover (no longer possible)

The way back to the three Node containers was removed with them (#2119, PR 7):
`render-config.sh` only knows the unit upstreams, and `scripts/deploy/index.js`
(the old Node deploy) is gone. The old containers are stopped, not removed, on
a host that cut over, but the proxy no longer routes to them, and
`scripts/deploy/units.sh --proxy-only` deploys a proxy-only image that routes
to the units' sockets, not to them. The way back from a bad unit image is an
older unit image, `npm run deploy-units -- <commit>`.

The Deploy workflow always deploys units; the **Deploy proxy** workflow is gone.

## Setting up a host

1. **An image.** `.github/workflows/proxy-image.yml` publishes
   `ghcr.io/blotcms/blot-proxy:<sha>` (multi-arch, built with
   `LOG_TO_STDOUT=false` because `fail2ban`, `logrotate` and the `.bashrc`
   helpers read `/var/instance-ssd/logs/access.log` and the container has no
   ban layer of its own; `blue-green.sh` refuses an image that logs to stdout).
   It builds every push to master. Pass the SHA to a script;
   anything containing `/` or `:` is used as a full image reference.
2. **`/etc/blot/proxy.env`** from the example. `PROXY_UPSTREAM_*` are read only while the old Node containers still run (before the
   cutover), so leave them unset on a host that has cut over. The units' sockets come
   from the settings the scripts write; `/run/blot` is mounted into the proxy and each
   socket is checked before and after the swap. `PROXY_PRIVATE_IP` and
   `PROXY_REDIS_HOST` (both required, the scripts refuse empty values) must be the host's private IP and Redis host, and `BLOT_REVERSE_PROXY_URLS`
   in `/etc/blot/secrets.env` must point at `http://<PROXY_PRIVATE_IP>:8077`,
   because Node purges the cache from a Docker bridge that cannot see the
   host's `127.0.0.1`. The units read these at start, so redeploy after editing them.
   GitHub's Deploy workflow runs the scripts as the `deploy` user, which
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

## Two proxies

`blot-blue` and `blot-green` are always running, from the same image, both
`--network host` and sharing `:80`/`:443` with `reuseport`. The names are final.
`blue-green.sh`
looks at what is running and does one of:

- **steady** (both units up): for blue, then green: refuse unless the other
  unit is running and healthy (its health socket answers); skip a unit that
  already runs this image and is healthy (a re-run is a no-op); otherwise
  `docker stop --time 30` it (40 for a unit, which drains OpenResty and then
  node-a), rename it `blot-<unit>-previous`, create and start
  the new one, wait for its health socket, run the site checks, give it its
  restart policy and remove `-previous`. Any failure removes the new
  container, starts `-previous` again and renames it back, and the deploy stops
  without touching the other unit. If the old one will not come back healthy
  the new one is left running if it is healthy, with a loud warning.
- **partial** (one unit up): the missing one is started first, beside the
  running one, and checked; then as steady.
- **legacy** (one `blot-proxy-<colour>` up, no unit): both units are started
  beside it and checked, then the legacy proxy is stopped, the site checked
  again and the legacy container removed. A failure removes what was started
  and leaves the legacy proxy running.
- **fresh** (nothing up): the cache directory is emptied, then blue and green
  are started, each checked (200 with the right certificate, every custom
  domain with its own certificate) before it is made permanent.

A new container has restart policy `no` until its checks pass. The site checks
go to the host's `:443`, which either unit may answer, so what proves the new
container is its own health socket; stopping the old unit first means the
checks are answered by the new one and the other, already healthy, unit.

`docker ps --filter name=` is a substring regex: `name=blot-blue` also matches
`blot-blue-previous` and `name=blot-` matches every container whose name starts with `blot-`. The
scripts compare whole names; use `--filter 'name=^blot-blue$'` by hand.

A deploy never stops a unit whose other is unhealthy, so with green unhealthy it
refuses to replace blue: restart the unhealthy one first (`docker restart
blot-green`; the health cron does it within a minute), then deploy.

A killed deploy can leave `blot-<unit>-previous`. If its unit is running and
healthy the next deploy removes it; if not, it refuses and prints the three
commands that put the old one back.

## Cache directory

Every image keeps its cache (`diskcache.lua`) in one host directory,
`/var/instance-ssd/disk-cache` (`PROXY_DISK_CACHE_DIR`), which `blue-green.sh`
mounts at `/var/cache/openresty`. It must exist and belong to uid 1000
(`mount-instance-store.sh` creates it at boot; otherwise
`sudo install -d -o 1000 -g 1000 <dir>`).

- A deploy touches nothing and keeps the warm cache. Both units (and a
  replacement) share the directory, so a purge reaching any one purges all, and
  a replacement that fails after the old container was stopped needs no cleanup
  before it is started again.
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
containers were removed), `blue-green.sh` starts both units. It also refuses
while a legacy `openresty` systemd unit is active or enabled, which would
conflict with the container for `:80`/`:443`.

Before the two units production ran one proxy,
alternately `blot-proxy-blue` and `blot-proxy-green`.

To roll back, redeploy an older image (both units are replaced in turn):

```sh
npm run deploy-units -- <older-commit>
```

or run the Deploy workflow with that commit.

## Known gaps

- **`:8999` ACME hook** during the overlap, until `PROXY_ACME_HOOK_SECRET` is set in `proxy.env` (the deploy logs a warning while it is not): see `proxy/README.md`.
- The container has no `fail2ban` of its own; it relies on the host's reading
  the shared log directory (hence the log-mode guard above).
