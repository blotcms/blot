# Containerised OpenResty proxy (build-only scaffolding)

This directory is a work-in-progress containerisation of the OpenResty reverse
proxy that currently runs on bare metal from [`config/openresty`](../config/openresty).

**It is not wired to production.** Nothing here is deployed, and merging it
changes no running system. The goal at this stage is only that the image
builds, the generated config is valid, and the container boots and serves a
health check, so the work stops rotting while the remaining pieces are done
separately.

## Layout

| Path | Purpose |
| --- | --- |
| `config/` | Generated copy of [`config/openresty/conf`](../config/openresty/conf). Do not edit. |
| `html/` | Generated copy of [`config/openresty/html`](../config/openresty/html). Do not edit. |
| `build/sync-config.js` | Copies the canonical files into `config/` + `html/` and applies container-only patches (stdout logs, `reuseport`, ACME CA, health socket, ...). |
| `build/index.js` | Renders `config/server.conf` + partials into a single `openresty.conf`. |
| `build/build.sh` | Wrapper that runs `build/index.js` with the container's paths. Run this before `docker build`. |
| `build/data/latest/` | Generated output (git-ignored). |
| `Dockerfile` | Two-stage build: vendors the Lua deps, then assembles the image. |
| `entrypoint.sh` | Fixes volume ownership, optionally trusts a test ACME CA, then starts OpenResty with a SIGTERM drain (`openresty -s quit`). |
| `deploy/` | `blue-green.sh` (image swap via SO_REUSEPORT + drain, per-container health socket, requires a real cert mount) and `reload-config.sh` (installs the regenerated `nginx.conf` and reloads). Mechanism only - not wired to production. |
| `tests/` | Cache (`cacher.lua`) behaviour specs. Run as the `proxy` suite in the `node` workflow's test matrix, same as `config/openresty`. |
| `e2e/` | Full-stack checks driven through the built image (stub upstream + a real Blot app container + Pebble for certs). Run by the `integration` workflow. |

## Build and run locally

```sh
# Base domain for the generated vhosts is a BUILD-time value:
BLOT_HOST=example.com bash proxy/build/build.sh   # defaults to blot.im
docker build -f proxy/Dockerfile -t blot-proxy proxy/
docker run --rm --cap-add SYS_NICE -p 8080:80 -p 8443:443 \
  -e BLOT_HOST=example.com blot-proxy
curl -i http://localhost:8080/health   # -> 200
```

`BLOT_HOST` at `docker run` time is only read by `entrypoint.sh` for
certificate handling; it does not change the already-generated vhosts. Set it
when running `build.sh` to change the domain the config is built for.
`build.sh` also fetches BunnyCDN edge IPs for the rate-limit whitelist (same
as `config/openresty/build-config.js`); CI sets `FETCH_CDN_IPS=false` so image
builds do not depend on that API.

`--cap-add SYS_NICE` avoids a harmless `setpriority(-20) failed` alert from
`worker_priority` in an unprivileged container.

CI runs the same steps in [`.github/workflows/proxy.yml`](../.github/workflows/proxy.yml)
on any change under `proxy/` or `config/openresty/` (plus `package.json` and
`config/index.js`, which the generator reads).

## Certificate issuance for custom domains

`lua-resty-auto-ssl` issues a certificate on the first HTTPS request for a
custom blog domain and stores it in Redis (`storage_adapter = redis`). The
wildcard `*.blot.im` / `blot.im` certificate is still a static file mounted
over `/etc/ssl/private/letsencrypt-domain.{pem,key}` (the image ships a
self-signed placeholder so OpenResty can start).

- **Which domains are allowed**: `allow_domain` in
  [`config/openresty/conf/init.conf`](../config/openresty/conf/init.conf) returns true only if
  `domain:<host>` exists in Redis (Blot writes this key in
  `app/models/blog/set.js`) or the cert is already cached.
- **ACME endpoint**: baked at generate time from `ACME_CA`
  (`proxy/build/build.sh`), default Let's Encrypt production. CI overrides it
  with a local [Pebble](https://github.com/letsencrypt/pebble) server - see
  the `cert-issuance` job in
  [`.github/workflows/integration.yml`](../.github/workflows/integration.yml),
  which issues a real cert through the proxy and checks it survives a
  container recreate.
- **Trusting a test CA**: set `ACME_CA_CERT` to a PEM path (mounted into the
  container); `entrypoint.sh` exports `CURL_CA_BUNDLE`/`SSL_CERT_FILE` so the
  `dehydrated` hook accepts a non-public ACME endpoint. Unset in production.
- **Manual pre-cutover check**: on a host with a throwaway public domain and
  inbound :80, generate with
  `ACME_CA=https://acme-staging-v02.api.letsencrypt.org/directory`, add
  `domain:<that-domain>` to Redis, and confirm a staging-trusted cert is
  issued on first request.

### Possible replacement for `lua-resty-auto-ssl` (to investigate)

`lua-resty-auto-ssl` is effectively unmaintained, and its shell-out chain
(`dehydrated` + `sockproc` + the `:8999` hook server) is why the image vendors
and patches so much, why `dehydrated` has drifted from the bare-metal pin, and
why issuance can be flaky during a blue/green overlap. Options worth a spike
before cutover - none evaluated or tested yet:

- **[`lua-resty-acme`](https://github.com/fffonion/lua-resty-acme)** - pure-Lua
  ACMEv2 client with an on-demand `autossl` mode; would keep OpenResty and
  `allow_domain`, and drop the `dehydrated`/`sockproc`/`:8999` machinery. Open
  questions: Redis key-layout compatibility with existing certs, OCSP stapling,
  and behaviour across a blue/green overlap. The Pebble `cert-issuance` CI job
  is the natural acceptance test.
- **Issue from the Blot app** (e.g. `acme-client`) when a domain is connected,
  write the cert to Redis, and have the proxy only read it. Takes issuance out
  of the request path and would allow validating DNS first (see the root
  `TODO`).
- Caddy on-demand TLS would work but means replacing the OpenResty layer, so
  it is not a certs-only change. The official `nginx-acme` module is aimed at
  statically declared `server_name`s and probably does not fit on-demand
  issuance (unverified).

## Deployment (mechanism only - not wired to production)

The container runs with `--network host` (the generated upstreams are
`127.0.0.1:8088-8091`). Two kinds of change:

- **Config-only** (a `.conf` edit): keep the container, use
  [`deploy/reload-config.sh`](deploy/reload-config.sh)`<container> <host-conf-dir>`
  - it regenerates the config, **writes `nginx.conf` into the bind-mounted
    config dir**, then runs `openresty -t` and `openresty -s reload` inside
    the container. The listening sockets are never dropped. `cacher.lua` /
    `html` need their own bind-mounts if a change touches them.
- **Image change** (base image, Lua deps, Dockerfile): use
  [`deploy/blue-green.sh`](deploy/blue-green.sh). The generated config sets
  `reuseport` on the single default server for `:80` and `:443` (and on the
  loopback-only `:80` / `:8999` helpers), so the new container joins the
  listening group before the old one leaves it. The script waits for the new
  container to answer its **own per-container health socket**
  (`/run/openresty/health.sock` - not a reuseport TCP port the old container
  could answer for it), then `docker stop --time 30` the old one -
  `entrypoint.sh` traps SIGTERM and runs `openresty -s quit`, so in-flight
  requests drain first. It refuses to run without `PROXY_CERT_MOUNT` (the
  image ships only a self-signed placeholder). The `zero-downtime` job in the
  `integration` workflow exercises the handover under load.
  - *Known limitation*: during the seconds-long overlap the kernel can route
    a `:8999` ACME hook request to the other instance, whose hook secret
    differs, so first-issuance for a brand-new domain can be briefly flaky
    *while a deploy is in progress*. Tracked in `TODO`.

Run with persistent volumes:

```sh
docker run -d --network host --cap-add SYS_NICE \
  -e BLOT_HOST=blot.im \
  -v blot-proxy-cache:/var/cache/openresty \
  -v blot-proxy-auto-ssl:/etc/resty-auto-ssl \
  -v /host/certs:/etc/ssl/private:ro \
  blot-proxy
```

- **`blot-proxy-cache`** keeps the proxy cache warm across a redeploy.
- **`blot-proxy-auto-ssl`** keeps the dehydrated ACME account / hook state, so
  a redeploy does not re-register with the ACME server. The issued
  certificates themselves live in **Redis** (`storage_adapter = redis`), which
  is what makes them survive a container swap.

`entrypoint.sh` chowns the volume roots to `ec2-user` on boot (they mount
root-owned); it does **not** recurse into the cache.

## Pinned dependencies

Reproducibility relies on pinning, because the upstream toolchain has drifted:

- Base image `openresty/openresty:1.25.3.1-alpine-fat` — newer `alpine-fat`
  tags ship GCC 14, which will not compile `sockproc`.
- Lua modules (`lua-resty-auto-ssl` 0.13.1, `lua-resty-http` 0.17.2,
  `shell-games` 1.1.0) are fetched as checksummed `.src.rock` archives from
  luarocks.org rather than via the images' bundled `luarocks`, whose remote
  manifest no longer loads.
- `resty.auto-ssl.vendor.shell` and `sockproc` are pinned to the same commits
  the `lua-resty-auto-ssl` Makefile uses.

## Not done yet

Still build-only scaffolding: nothing here is deployed. Certificate issuance,
the deploy mechanism and persistent volumes now exist and are covered by CI
(above), but before this can replace `config/openresty`:

- **Fold container adaptations back in.** `proxy/build/sync-config.js` still
  patches a copy of `config/openresty` (stdout logs, `reuseport`, ACME CA,
  the per-container health socket). When this directory becomes canon, those
  bits belong in the files themselves and the copy step goes away.
- **Redis auth/TLS**. `config/openresty/conf/init.conf` hard-codes port 6379 with no auth;
  production Redis credentials need wiring.
- **Secret delivery**. `NODE_SERVER_IP`, `REDIS_IP` and the netdata creds are
  build-time inputs to the generator; decide build-arg vs runtime-env.
- **Redis outage handling**. Node answers 503 with a `Retry-After` and
  `no-store` page when it cannot reach Redis, but the proxy does not handle
  this yet. It replaces an upstream 503 with the "offline" page, retries it on
  the next container (each 503 counts against `max_fails`), `allow_domain` in
  `init.conf` returns true when the Redis lookup errors (it should fail
  closed), and `resty.redis` timeouts default to 60s, including inside the
  auto-ssl storage adapter. Fix these here and in `config/openresty`, with an
  e2e check against the stub upstream. Tracked in `TODO`.
- **`fail2ban` / `logrotate`** are host-level in `config/openresty`; the
  container logs to stdout/stderr (so `docker logs` and the host's log
  shipper work) but has no equivalent request-ban layer.

Tracked in the repo's `TODO` under "Proxy container (OpenResty)".

## Tests

- **`proxy` suite** (`.github/workflows/node.yml` test matrix) runs
  `proxy/tests/*.js` inside the Blot dev image, spinning up OpenResty against
  `config/openresty/conf/cacher.lua` - the `cacher.lua` behaviour specs (`basic`, `gzip`,
  `inspect`, `lru_purge`, `rehydrate`, plus `coverage` for per-host keys,
  method/health cacheability, binary bodies and argument validation).
- **`integration` workflow** (`.github/workflows/integration.yml`):
  - `proxy/e2e/checks.sh` drives the built image against
    `proxy/e2e/stub-upstream.js` - Host-based routing (site over HTTPS, blogs
    and custom domains over HTTP), `/.git` and `wp-admin` blocking, `Blot-Cache`
    MISS then HIT, gzip negotiation, upstream-error handling.
  - `proxy/e2e/run.js` brings the image up with the Blot app image + Redis
    (`proxy/e2e/docker-compose.yml`, with persistent cache/auto-ssl volumes)
    and goes through the proxy end to end: the site loads, the sign-in page
    renders, a seeded user signs in / reaches the dashboard / signs out, and a
    seeded blog (`proxy/e2e/seed-blog.js`) renders on its own vhost with the
    proxy cache going MISS then HIT.
  - `cert-issuance` issues a real custom-domain certificate through the proxy
    against a Pebble ACME server and checks it persists across a container
    recreate.
  - `zero-downtime` runs two proxy containers sharing `:80`/`:443` via
    SO_REUSEPORT and asserts no request is dropped while the first is stopped
    with a drain timeout.
