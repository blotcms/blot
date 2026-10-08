# Containerised OpenResty proxy

The OpenResty reverse proxy that fronts Blot. Production has run it from this
image since 8 Oct 2026 (#1941), deployed with `npm run deploy-proxy` or the
Deploy proxy workflow (see [`deploy/README.md`](deploy/README.md)). The
nginx config and Lua in `config/` are the only copy: the bare-metal OpenResty
install that preceded the container remains on the host, stopped and
disabled, as a manual rollback, but nothing in this repo renders its config.

## Layout

| Path | Purpose |
| --- | --- |
| `config/` | The nginx config as mustache templates (`server.conf` includes the others as partials) plus `cacher.lua`. Edit these. |
| `html/` | Error pages served when an upstream is offline. |
| `build/index.js` | Renders `config/server.conf` + partials into a single `openresty.conf`, with the locals from [`build/locals.js`](build/locals.js). `tests/locals.js` fails if a template reads a variable that `locals.js` leaves undefined. |
| `build/build.sh` | Wrapper that runs `build/index.js` with the container's paths. Run this before `docker build`. |
| `build/data/latest/` | Generated output (git-ignored). |
| `Dockerfile` | Two-stage build: vendors the Lua deps, then assembles the image. |
| `entrypoint.sh` | Fixes volume ownership, optionally trusts a test ACME CA, then starts OpenResty with a SIGTERM drain (`openresty -s quit`). |
| `deploy/` | `blue-green.sh` (image swap via SO_REUSEPORT + drain, per-container health socket, requires a real cert mount) (and `reload-config.sh`, which needs a bind-mounted conf dir the production scripts do not use). They are run on the host; see [`deploy/README.md`](deploy/README.md) for the checks each script makes. |
| `tests/` | Cache (`cacher.lua`) behaviour specs and a check that every variable the config reads has a value. Run as the `proxy` suite in the `node` workflow's test matrix. |
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

### Runtime settings

The image holds the generated config as a template. On every start
`entrypoint.sh` runs [`render-config.sh`](render-config.sh), which fills in
these from the container's environment (`-e` or `--env-file`), so one image
serves any host:

| Variable | Default | |
| --- | --- | --- |
| `PROXY_REDIS_HOST` | build-time `REDIS_IP`, else `127.0.0.1` | Redis for certificates and the domain allowlist |
| `PROXY_SERVER_LABEL` | build-time `SERVER_LABEL`, else `us` | the `Blot-Server` response header |
| `PROXY_PRIVATE_IP` | build-time `OPENRESTY_INSTANCE_PRIVATE_IP`, else `127.0.0.1` | address of the extra `:8077` cache-purge listener, for Node containers that cannot reach the host's `127.0.0.1:80` |
| `PROXY_RESOLVER` | build-time `OPENRESTY_RESOLVER`, else `8.8.8.8 ipv6=off` | DNS resolver (`127.0.0.11` on a user-defined Docker network) |
| `PROXY_ACME_CA` | build-time `ACME_CA`, else Let's Encrypt production | ACME directory for custom-domain certificates. Leave it alone in production: the deploy scripts refuse anything else in `proxy.env` |
| `PROXY_UPSTREAM_GREEN` | `127.0.0.1:8089` | the master Node (webhooks, `/clients`) |
| `PROXY_UPSTREAM_BLUE` | `127.0.0.1:8088` | the dashboard Node, and failover for the others |
| `PROXY_UPSTREAM_YELLOW` | `127.0.0.1:8090` | the blog Node |
| `PROXY_FETCH_CDN_IPS` | `true` | fetch the Bunny edge list (exempt from rate limits) at start; `false` uses the list baked into the image |

The upstream groups keep their weights and failover roles from
`config/http.conf`; only where each Node is changes. The Bunny
list is fetched on start and falls back to the baked-in one, so a running
container does not pick up changes to it until it restarts.

`BLOT_HOST` at `docker run` time is only read by `entrypoint.sh` for
certificate handling; it does not change the already-generated vhosts. Set it
when running `build.sh` to change the domain the config is built for.
`build.sh` also fetches BunnyCDN edge IPs for the rate-limit whitelist (the
list baked into the image as a fallback); CI sets `FETCH_CDN_IPS=false` so image
builds do not depend on that API.

HTTP/3 (QUIC) is served on UDP `:443` as on bare-metal, so the host firewall and
security group must allow UDP 443 as well as TCP. `-p 443:443/udp` when not
using `--network host`.

`--cap-add SYS_NICE` avoids a harmless `setpriority(-20) failed` alert from
`worker_priority` in an unprivileged container.

CI runs the same steps in [`.github/workflows/proxy.yml`](../.github/workflows/proxy.yml)
on any change under `proxy/` (plus `package.json` and
`config/index.js`, which the generator reads).

## Certificate issuance for custom domains

`lua-resty-auto-ssl` issues a certificate on the first HTTPS request for a
custom blog domain and stores it in Redis (`storage_adapter = redis`). The
wildcard `*.blot.im` / `blot.im` certificate is still a static file mounted
over `/etc/ssl/private/letsencrypt-domain.{pem,key}` (the image ships a
self-signed placeholder so OpenResty can start).

- **Which domains are allowed**: `allow_domain` in
  [`config/init.conf`](config/init.conf) returns true only if
  `domain:<host>` exists in Redis (Blot writes this key in
  `app/models/blog/set.js`) or the cert is already cached.
- **ACME endpoint**: the runtime setting `PROXY_ACME_CA`, default Let's
  Encrypt production. CI sets it to a local
  [Pebble](https://github.com/letsencrypt/pebble) server - see
  the `cert-issuance` job in
  [`.github/workflows/integration.yml`](../.github/workflows/integration.yml),
  which issues a real cert through the proxy and checks it survives a
  container recreate.
- **Trusting a test CA**: set `ACME_CA_CERT` to a PEM path (mounted into the
  container); `entrypoint.sh` exports `CURL_CA_BUNDLE`/`SSL_CERT_FILE` so the
  `dehydrated` hook accepts a non-public ACME endpoint. Unset in production.
- **Check against a real ACME server before deploying an image**:
  [`deploy/try-issuance.sh`](deploy/try-issuance.sh) runs the image with
  `PROXY_ACME_CA` set to Let's Encrypt staging for a throwaway domain and
  confirms a staging certificate is issued. See
  [`deploy/README.md`](deploy/README.md).
- **When Redis is down**: auto-ssl caches each certificate in memory for an
  hour, then reads Redis again. A handshake that cannot read Redis falls back
  to the last certificate this proxy read for that domain (the
  `auto_ssl_stale` shared dict, kept until the certificate expires), so
  domains served recently keep HTTPS through a longer outage. Domains it has
  no copy of get the fallback certificate, and nothing new is issued. The
  copies are in memory: they survive `openresty -s reload` but not a restart
  or a new container, so do not restart or redeploy the proxy while Redis is
  down. `PROXY_AUTO_SSL_CACHE_TTL` (seconds) shortens the hour; it exists for
  the CI checks and is unset in production.

### Possible replacement for `lua-resty-auto-ssl` (to investigate)

`lua-resty-auto-ssl` is effectively unmaintained, and its shell-out chain
(`dehydrated` + `sockproc` + the `:8999` hook server) is why the image vendors
and patches so much, why `dehydrated` is vendored separately from its pin, and
why issuance can be flaky during a blue/green overlap. Options worth a spike
(none evaluated or tested yet):

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

## Deployment

The container runs with `--network host` (the generated upstreams are
`127.0.0.1:8088-8091`). Two kinds of change:

- **Config-only** (a `.conf` edit): ship it as a new image like any other
  change. [`deploy/reload-config.sh`](deploy/reload-config.sh) can reload a
  container whose conf directory is bind-mounted, but the production
  containers do not mount one.
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

### Cache purging

Node purges each proxy in `BLOT_REVERSE_PROXY_URLS` independently
([`app/helper/flushCache.js`](../app/helper/flushCache.js)): a proxy that is
down, slow (5s timeout) or returning errors does not stop the others being
purged. Hosts a proxy missed are recorded in Redis
(`flushCache:pending:<proxy url>`) and re-sent every 30s until it accepts
them, so a proxy that was restarting during a purge does not keep serving
stale pages from its warm cache.

Set `BLOT_PURGE_TOKEN` on both Node and the proxy to require an
`X-Blot-Purge-Token` header on the internal `/purge`, `/inspect` and
`/rehydrate` endpoints. With it unset the endpoints are open, as before. To
enable it, set it on Node first (an unauthenticated proxy ignores the header),
then on the proxies.

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

Open items are tracked in the repo's `TODO` under "Proxy container (OpenResty)"
and "Proxy container follow-ups". The main ones:

- **Redis auth/TLS**. `config/init.conf` hard-codes port 6379 with no auth;
  production Redis credentials need wiring.
- **`fail2ban` / `logrotate`** are host-level in [`config/host`](../config/host); the
  container logs to stdout/stderr by default (so `docker logs` works), but the
  production image is built with `LOG_TO_STDOUT=false` so the host's fail2ban
  and logrotate can read the shared log directory, and the container has no
  request-ban layer of its own.
- **Replacing `lua-resty-auto-ssl`** (above).

## Tests

- **`proxy` suite** (`.github/workflows/node.yml` test matrix) runs
  `proxy/tests/*.js` inside the Blot dev image, spinning up OpenResty against
  `config/cacher.lua` - the `cacher.lua` behaviour specs (`basic`, `gzip`,
  `inspect`, `lru_purge`, `rehydrate`, `startup`, plus `coverage` for per-host keys,
  method/health cacheability, binary bodies and argument validation).
- **`integration` workflow** (`.github/workflows/integration.yml`):
  - `proxy/e2e/checks.sh` drives the built image against
    `proxy/e2e/stub-upstream.js` - Host-based routing (site over HTTPS, blogs
    and custom domains over HTTP), `/.git` and `wp-admin` blocking, `Blot-Cache`
    MISS then HIT, gzip negotiation, upstream-error handling, and a Node 503
    (Redis outage) passing through with its `Retry-After`.
  - `proxy/e2e/run.js` brings the image up with the Blot app image + Redis
    (`proxy/e2e/docker-compose.yml`, with persistent cache/auto-ssl volumes)
    and goes through the proxy end to end: the site loads, the sign-in page
    renders, a seeded user signs in / reaches the dashboard / signs out, and a
    seeded blog (`proxy/e2e/seed-blog.js`) renders on its own vhost with the
    proxy cache going MISS then HIT.
  - `proxy-behaviour` also makes real HTTP/3 requests (`proxy/e2e/h3-check.py`, aioquic) for the site and for a custom domain.
  - `cert-issuance` issues a real custom-domain certificate through the proxy
    against a Pebble ACME server, checks it persists across a container
    recreate, and checks that a Redis which stops answering neither stalls the
    handshake nor lets the proxy start issuing for an unlisted domain. Then
    [`e2e/redis-outage-checks.sh`](e2e/redis-outage-checks.sh) stops Redis
    and checks the issued certificate is still served past the (shortened)
    cache, including after a reload, that a newer certificate in Redis wins
    once it is back, and that `READONLY` / `NOREPLICAS` Redis still serves
    certificates while issuance fails fast.
  - `zero-downtime` runs two proxy containers sharing `:80`/`:443` via
    SO_REUSEPORT and asserts no request is dropped while the first is stopped
    with a drain timeout.
