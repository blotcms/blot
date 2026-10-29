# Containerised OpenResty proxy

The OpenResty reverse proxy that fronts Blot. Production has run it from this
image since 8 Oct 2026 (#1941), deployed with `npm run deploy-proxy` or the
Deploy proxy workflow (see [`deploy/README.md`](deploy/README.md)). The
nginx config and Lua in `config/` are the only copy. The bare-metal OpenResty
install that preceded the container has been removed from the host; to roll
back, deploy an older image.

## Layout

| Path | Purpose |
| --- | --- |
| `config/` | The nginx config as mustache templates (`server.conf` includes the others as partials) plus `diskcache.lua`, the cache. Edit these. |
| `html/` | Error pages served when an upstream is offline. |
| `build/index.js` | Renders `config/server.conf` + partials into a single `openresty.conf`, with the locals from [`build/locals.js`](build/locals.js). `tests/locals.js` fails if a template reads a variable that `locals.js` leaves undefined. |
| `build/build.sh` | Wrapper that runs `build/index.js` with the container's paths. Run this before `docker build`. |
| `build/data/latest/` | Generated output (git-ignored). |
| `Dockerfile` | Three-stage build: vendors the Lua deps, builds the Brotli modules, then assembles the image. |
| `SECURITY.md` | OpenResty/nginx upgrade assessment, enabled features, and remaining advisory exposure. |
| `entrypoint.sh` | Fixes volume ownership, optionally trusts a test ACME CA, then starts OpenResty with a SIGTERM drain (`openresty -s quit`). |
| `deploy/` | `blue-green.sh` (replaces the two always-running proxy units one at a time via SO_REUSEPORT + drain, per-container health socket, requires a real cert mount) (and `reload-config.sh`, which needs a bind-mounted conf dir the production scripts do not use). They are run on the host; see [`deploy/README.md`](deploy/README.md) for the checks each script makes. |
| `evict.sh` | The cache sweeper, run hourly by `diskcache.lua` (see "Cache" below). |
| `tests/` | Specs for the scanner ban and push limits, and a check that every variable the config reads has a value. Run as the `proxy` suite in the `node` workflow's test matrix. |
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
| `PROXY_ACME_HOOK_SECRET` | unset: each instance generates its own (a warning is logged) | the secret dehydrated's hook calls carry to the `:8999` hook server. Set it to the same long random string on every instance: they share `:8999` (`reuseport`), so a call can reach either. Read by `init.conf` (never written into `nginx.conf`) |
| `PROXY_UNIT` | `-` | `blue` or `green`: logged as the last field of every access log line (`unit=`). The deploy script sets it from the container name (`blot-blue` is `blue`) |
| `PROXY_UPSTREAM_GREEN` | `127.0.0.1:8089` (production: `unix:/run/blot/green.sock`) | the Node that handles sync, writes and webhooks (`/clients`) |
| `PROXY_UPSTREAM_BLUE` | `127.0.0.1:8088` (`unix:/run/blot/blue.sock`) | the dashboard Node, and failover for the others |
| `PROXY_UPSTREAM_YELLOW` | `127.0.0.1:8090` (`unix:/run/blot/yellow.sock`) | the blog Node |
| `PROXY_UPSTREAM_MODE` | `containers` | `containers`: the three Node containers above. `unit`: this container also runs its own two Node processes (the [unit image](#the-unit-image)) and the next four are used instead |
| `PROXY_UNIT_MAIN` | `unix:/run/blot/blue-a.sock` | unit mode: this unit's main Node process (blogs, dashboard reads) |
| `PROXY_UNIT_WORKER` | `unix:/run/blot/blue-b.sock` | unit mode: this unit's worker child (`/clients`, webhooks, dashboard writes) |
| `PROXY_PEER_MAIN` | `unix:/run/blot/green-a.sock` | unit mode: the other unit's main process, `backup` for the two upstreams above |
| `PROXY_PEER_WORKER` | `unix:/run/blot/green-b.sock` | unit mode: the other unit's worker child, `backup` for `/clients` |
| `PROXY_FETCH_CDN_IPS` | `true` | fetch the Bunny edge list (exempt from rate limits) at start; `false` uses the list baked into the image |

The upstream groups keep their names, weights and failover roles from
`config/http.conf`; only where each Node is changes. In unit mode `blot_node`
is the unit's worker with the other unit's worker as `backup`, and
`blot_blogs_node` and `blot_dashboard_node` are the unit's main process with the
other unit's as `backup`; `render-config.sh` picks the servers from the mode. A `unix:` upstream is a socket the Node
container listens on in `/run/blot` (a failed connect is immediate, so nginx
retries the backup); the deploy scripts bind-mount that directory into the
proxy when any upstream is one. The Bunny
list is fetched on start and falls back to the baked-in one, so a running
container does not pick up changes to it until it restarts.

`BLOT_HOST` at `docker run` time is only read by `entrypoint.sh` for
certificate handling; it does not change the already-generated vhosts. Set it
when running `build.sh` to change the domain the config is built for.
`build.sh` also fetches BunnyCDN edge IPs for the rate-limit whitelist (the
list baked into the image as a fallback); CI sets `FETCH_CDN_IPS=false` so image
builds do not depend on that API.

HTTP/3 (QUIC) is temporarily disabled pending OpenResty security fixes (see
[`SECURITY.md`](SECURITY.md) and the task at the top of `TODO`). There are no
QUIC listeners; public server blocks send `Alt-Svc: clear` to expire cached
HTTP/3 routes. HTTPS continues over HTTP/2 and HTTP/1.1 on TCP 443.

`--cap-add SYS_NICE` avoids a harmless `setpriority(-20) failed` alert from
`worker_priority` in an unprivileged container.

CI runs the same steps in [`.github/workflows/proxy.yml`](../.github/workflows/proxy.yml)
on any change under `proxy/` (plus `package.json` and
`config/index.js`, which the generator reads).

## Certificate issuance for custom domains

`lua-resty-auto-ssl` issues a certificate on the first HTTPS request for a
custom blog domain and stores it in Redis (`storage_adapter = redis`). The
wildcard `*.blot.im` / `blot.im` certificate is served from Redis (below),
with a static file mounted over `/etc/ssl/private/letsencrypt-domain.{pem,key}`
as the fallback (the image ships a self-signed placeholder so OpenResty can
start).

- **The wildcard certificate**: [`config/wildcard_cert.lua`](config/wildcard_cert.lua)
  runs in `ssl_certificate_by_lua` (from a shared dict only, see below) on the wildcard server blocks and presents
  the chain in `blot:openresty:ssl:pem` and the key in `blot:openresty:ssl:key`,
  so a renewal that writes them takes effect with no reload. Redis is the
  source of truth; the file is only used when Redis has nothing usable. One
  worker (id 0) reads Redis from a timer every 10 seconds, so a renewal is served within
  about ten seconds,
  and publishes the validated chain and key to the `wildcard_cert` shared dict
  as one value. Handshakes only read that dict and never touch Redis, because
  a handshake that yields in `ssl_certificate_by_lua` breaks HTTP/3
  ([openresty#1049](https://github.com/openresty/openresty/issues/1049)).
  Writers should set the key and the chain together (`MSET`, as
  `app/scheduler/renew-wildcard-ssl.js` does with one `multi()`): the proxy reads both with one `MGET`, but a
  pair written one after the other can be read half-updated. If
  lua-resty-openssl is installed the proxy also rejects a key that does not
  match the certificate. If Redis cannot be reached, answers slowly (500ms
  timeouts), has no certificate or key, or has one that does not parse, the
  proxy keeps serving the last copy read from Redis (the file if there is
  none, or if Redis answered with no keys), logs one line per run of failures
  (`wildcard cert: ...`), and tries again after ten seconds. A cached copy that OpenSSL then refuses is dropped, so handshakes
  fall back to the file. Custom domains are unaffected; they use auto-ssl
  below. Checked by [`e2e/wildcard-cert-checks.sh`](e2e/wildcard-cert-checks.sh).

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

- **Expired certificates**: lua-resty-auto-ssl 0.13.1 serves whatever is
  stored for a domain without looking at its expiry, and only deletes a
  certificate from Redis when a daily renewal fails after it has expired (its
  in-memory copy then lingers for up to an hour). `get_cert` in
  `config/init.conf` therefore treats a stored certificate whose `expiry` has
  passed as missing: a domain still listed in Redis (`domain:<host>`) is
  issued a new one, any other gets the fallback certificate, and the key is
  left for renewal to delete. Deleting a certificate also drops this
  container's cached copies. Nothing on the host needs to restart the proxy to
  clear a stale certificate. The proxy still asks for an OCSP response on every
  handshake (0.13.1 cannot be told not to); Let's Encrypt certificates no
  longer name a responder, so this fails at once and is logged at notice level.

- **Key type**: `entrypoint.sh` writes `KEY_ALGO="prime256v1"` to
  `/etc/resty-auto-ssl/letsencrypt/conf.d/key-algo.sh` on every start (the
  directory is on a volume, so a file in the image would not show up), which
  dehydrated reads. New and renewed custom-domain certificates are ECDSA, with
  a shorter chain than RSA 4096; existing RSA ones keep working until their
  renewal. Nothing in the config, `wildcard_cert.lua` or the scheduler checks
  assumes a key type. The `*.blot.im` wildcard is issued by
  `app/scheduler/renew-wildcard-ssl.js`, not by dehydrated, and is also an
  ECDSA P-256 certificate from its next renewal.

### Scanner bans and TLS resumption

`ban.lua` bans a client IP for an hour after three `444` responses within two
minutes (the `444`s in `blot-blogs.conf` are for scanners; one alone may be a
typo). It runs in the log phase of every server, and the ban is enforced in
`ssl_client_hello_by_lua` (in `wildcard-ssl.conf`), which aborts the handshake
before a certificate is chosen or sent, and in `rewrite_by_lua` for requests
(plain HTTP, and HTTPS via Cloudflare, where the handshake only sees
Cloudflare's address). Whitelisted IPs (the `$whitelist` geo in `http.conf`),
loopback and private addresses are never banned. Bans live in the
`banned_ips` shared dict, so they are per container and lost on restart;
fail2ban (host) is the longer-lived layer. A `return` in a location (only
`/health`) runs before the rewrite phase and is not blocked. The http-level
`log_by_lua` is replaced in any location with its own (`reverse-proxy-cache.conf`
has one); that is harmless, as those locations proxy upstream and never return
444.

`ssl_session_cache` is 100m and `ssl_session_timeout` 24h (`wildcard-ssl.conf`):
a resumed handshake is about 250 bytes against about 5 KB for a full one.
Session tickets stay off.

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
  [`deploy/blue-green.sh`](deploy/blue-green.sh). Two proxy containers always
  run, `blot-blue` and `blot-green`; the generated config sets `reuseport` on
  the single default server for `:80` and `:443` (and on the loopback-only
  `:80` / `:8999` helpers), so both listen on the same ports and the kernel
  gives new connections to whichever are up: if one dies the other takes
  every new connection. A deploy replaces them one at a time, blue first: it
  refuses unless the other is running and healthy, `docker stop --time 30`
  the unit (`entrypoint.sh` traps SIGTERM and runs `openresty -s quit`, so
  in-flight requests drain first, while the other carries the traffic), keeps
  it stopped as `blot-<unit>-previous`, starts the new one under the unit's
  name and waits for it to answer its **own per-container health socket**
  (`/run/openresty/health.sock` - not a reuseport TCP port the other
  container could answer for it). Only when the site checks pass is the
  previous container removed; otherwise it is put back and the deploy stops
  before the other unit is touched. A host with the single proxy of before
  (`blot-proxy-blue` or `blot-proxy-green`) is moved to the two units by
  starting both beside it before stopping it, and a host missing one unit gets
  it started first. It refuses to run without `PROXY_CERT_MOUNT` (the image
  ships only a self-signed placeholder). The `zero-downtime` job in the
  `integration` workflow exercises the handover under load.
  - *Hook secret*: the `:8999` ACME hook server is shared by the instances
    through `reuseport`, so dehydrated's hook call can land on the other one.
    That works only if both hold the same secret, which they do when
    `PROXY_ACME_HOOK_SECRET` is set in `proxy.env`. Without it each instance
    generates its own and first issuance for a brand-new domain can fail
    while two are running (a warning is logged at start and by the deploy).
  - *Draining*: `worker_shutdown_timeout 10s` (`config/initial.conf`) ends
    any connection still open 10 seconds after the quit, inside the 30 second
    `docker stop` above.
  - *Renewal and issuance across instances*: challenge tokens are stored in
    Redis, so Let's Encrypt's validation request can reach either instance.
    Each instance has its own daily renewal timer; `config/init.conf` makes
    the first to start a pass (an `NX` key in Redis, `ssl:renewal-pass-lock`)
    the only one to run it, because auto-ssl's own per-domain lock is not
    atomic. Access log lines end with `unit=blue` or `unit=green`; the error
    log has no such tag.

### Cache

The cache is `config/diskcache.lua`: a shared on-disk cache under the cache
directory (`/var/cache/openresty`), with no index to rebuild, so containers
sharing the directory share the cache and a restart keeps it warm.

- Hits are served with sendfile. Misses go to the upstream through
  `@diskcache_fill`, which stores the response as it streams to the client.
- A purge writes a marker file for the host and renames the host's directory
  into `.trash`, which is emptied in the background. A fill that started
  before the purge sees the marker and discards its entry.
- Worker 0 makes brotli copies (`<body>.br`) of an entry's body after its
  first hit; `brotli_static` serves them to clients that accept `br`.
- `evict.sh` is the sweeper. It runs hourly, one sweep at a time (it holds a
  `flock`), and evicts the least recently read entries when the cache is over
  200 GB or the filesystem is over 90% full.

### Cache purging

Node purges each proxy in `BLOT_REVERSE_PROXY_URLS` independently
([`app/helper/flushCache.js`](../app/helper/flushCache.js)): a proxy that is
down, slow (5s timeout) or returning errors does not stop the others being
purged. Hosts a proxy missed are recorded in Redis
(`flushCache:pending:<proxy url>`) and re-sent every 30s until it accepts
them, so a proxy that was restarting during a purge does not keep serving
stale pages from its warm cache.

Set `BLOT_PURGE_TOKEN` on both Node and the proxy to require an
`X-Blot-Purge-Token` header on the internal `/purge` endpoint. With it unset
the endpoint is open, as before. To enable it, set it on Node first (an unauthenticated proxy ignores the header),
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

- **`blot-proxy-cache`** keeps the cache warm across a redeploy.
- **`blot-proxy-auto-ssl`** keeps the dehydrated ACME account / hook state, so
  a redeploy does not re-register with the ACME server. The issued
  certificates themselves live in **Redis** (`storage_adapter = redis`), which
  is what makes them survive a container swap.

`entrypoint.sh` chowns the volume roots to `ec2-user` on boot (they mount
root-owned); it does **not** recurse into the cache.

## The unit image

[#2119](https://github.com/blotcms/blot/issues/2119) replaces the proxy
container and the three Node containers with two identical units, `blot-blue`
and `blot-green`, each one container running OpenResty, node-a (the Node main
process) and node-b (the worker child node-a forks, `helper/workerChild`). The
image is the `unit` target of the root `Dockerfile`: the `prod` app image plus
OpenResty and the files in this image, which `COPY --from` the proxy image
built for the same commit (`PROXY_IMAGE`) rather than compiling OpenResty
again. [`unit-image.yml`](../.github/workflows/unit-image.yml) builds it after
the proxy image, boots it with [`unit/smoke.sh`](unit/smoke.sh) and publishes
`ghcr.io/<owner>/blot-unit:<sha>`. Nothing deploys it yet.

- **User.** One user at uid 1000, `ec2-user` (the Node image's `node` user,
  renamed), for the app and for OpenResty's workers. As in this image, the
  OpenResty master runs as root to bind 80 and 443; node-a is started with
  `su-exec`.
- **Supervisor.** [`unit/supervisor.sh`](unit/supervisor.sh) runs under tini.
  It starts OpenResty with [`start.sh`](start.sh) (`proxy-start`, the part of
  `entrypoint.sh` that prepares the container) and node-a. If node-a exits it
  is started again after 1s, doubling to 30s, reset once it has run for 60s,
  without touching OpenResty. If OpenResty exits the container exits non-zero.
  On SIGTERM, SIGQUIT or SIGINT it runs `openresty -s quit`, sends node-a
  SIGTERM (which drains it and node-b), waits for both and exits 0.
- **Config.** `BLOT_UNIT` (`blue` or `green`) is required. The supervisor
  derives the rest from it, unless set: node-a and node-b serve on
  `/run/blot/<unit>-a.sock` and `<unit>-b.sock`, and the proxy runs in
  `PROXY_UPSTREAM_MODE=unit` with those as `PROXY_UNIT_MAIN` and
  `PROXY_UNIT_WORKER` and the other unit's as `PROXY_PEER_MAIN` and
  `PROXY_PEER_WORKER` (see [Runtime settings](#runtime-settings)).
- **Health.** The `HEALTHCHECK` ([`unit/healthcheck.sh`](unit/healthcheck.sh))
  needs both the health socket and node-a's `/health`.

## Pinned dependencies

Reproducibility relies on pinning, because the upstream toolchain has drifted:

- Base image: the same `node:24.22.1-alpine` as the Node app, pinned by
  multi-architecture digest in the `NODE_BASE` argument of both `Dockerfile`s
  (`scripts/security/check-base-image.js` fails CI if they differ). OpenResty
  1.31.1.1 is compiled on it in the Dockerfile's `openresty` stage with the
  configure flags and bundled OpenSSL and PCRE2 of the official
  `openresty/openresty:alpine` image (docker-openresty `alpine/Dockerfile`),
  each download checked against a sha256. The `-fat` extras (perl, `resty`,
  `opm`, `restydoc`, luarocks, wget, unzip, outils-md5, the build packages) are
  not installed; nothing here uses them. The geoip, image_filter and xslt
  dynamic modules are built as in the official image but their libraries are
  not installed, so they cannot be loaded without adding gd, geoip and libxslt.
  The workers run as `ec2-user` (uid 1000), the base's `node` user renamed. The
  local `sockproc` signal-handler patch supports modern compilers without
  dropping the upstream warning checks.
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
  and logrotate can read the shared log directory. The nginx-* jails ban with
  a second `iptables-multiport` action for UDP so the ban covers UDP 443
  (HTTP/3) too, without blocking ssh. The container has its own short-lived scanner ban (`ban.lua`, above).
- **Replacing `lua-resty-auto-ssl`** (above).

## Tests

- **`proxy` suite** (`.github/workflows/node.yml` test matrix) runs
  `proxy/tests/*.js` inside the Blot dev image: the scanner ban (`ban`,
  spinning up OpenResty against `config/ban.lua`), the push limits, the body
  limit on auth routes and the locals check. The cache and the `/purge` token
  check are tested against the built image by the `integration` workflow.
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
  - `proxy-behaviour` checks that the rendered config and live UDP sockets expose no QUIC listener, and that HTTP/1.1 and HTTP/2 still serve every public vhost without advertising HTTP/3. It repeats the checks with the wildcard certificate from Redis. `proxy/e2e/h3-check.py` is retained for re-enabling HTTP/3 after the security fixes.
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
