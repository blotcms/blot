# Real-Docker end-to-end tests for the proxy deploy scripts

`proxy/deploy/tests/run.sh` drives `blue-green.sh` against fake
`docker`/`curl`/`systemctl`/`openssl` to check the order of operations. This
directory instead runs the **real** script against **real** Docker and Redis,
in `.github/workflows/proxy-deploy-e2e.yml`.

The units are stand-ins: the real proxy image plus a stub in place of the app
(`unit/`), labelled `im.blot.kind=unit` as `blue-green.sh` requires, with a
stand-in airlock. What this does not cover is the app itself (building and
booting the real unit image is `unit-image.yml`'s job, `proxy/unit/smoke.sh`):
the real verify-container checks, the real airlock, node-a and node-b starting
from the real image, and the memory limit holding the real heaps.

The `unit-deploy-e2e` job starts with no unit running, so the first scenario is
the fresh start `blue-green.sh` does when nothing is serving (both units,
`blot-blue` and `blot-green`, and their airlocks), and the rest go from there:
a re-run that must change nothing, a deploy that replaces blue and then green
under load with no failed request, and the failures a deploy must roll back
from. (The one-off move from the bare-metal OpenResty to
the first container, a one-off script, ran on 8 Oct 2026 under
[#1941](https://github.com/blotcms/blot/issues/1941) and was deleted along
with the bare-metal stand-in this harness used to need.)

## What's here

- `gen-certs.sh` - a self-signed CA plus a wildcard leaf certificate for
  `BLOT_HOST`, trusted in the runner's CA store so `curl`'s ordinary
  certificate validation (`https_status` in `proxy/deploy/common.sh`) passes.
- `deploy-under-load.sh` - runs `blue-green.sh` for an image while a loop sends
  a request every 50 ms and fails on any that is not a 200.
- `setup.sh` - brings up Redis and the stub upstream
  (`proxy/e2e/stub-upstream.js`), and writes the `proxy.env` files the
  scenarios use.
- `unit-setup.sh` - the host side of a unit deploy: `/run/blot`, the data and
  tmp directories, `unit-settings.env` and `secrets.env`.
- `unit/` - the stand-in unit (`Dockerfile`, `supervisor.sh`, `stub-node.js`,
  `verify.js`) and the stand-in airlock (`airlock.Dockerfile`).
  `build-unit-image.sh` builds a unit on a proxy image from a source tree.

## Deploying an image under load

`unit-swap-load-e2e` (same workflow, own job) runs `swap-load.sh`: one unit image
deployed over another by the real `blue-green.sh`, against real Docker, Redis and
a stub upstream (the stand-in units send their traffic to it,
`E2E_UPSTREAMS_FROM_ENV`), while a load generator never stops. Every deploy is
rehearsed this way, so a change that would drop, reset, corrupt or leave stale a
request during a deploy shows up here first. By default both images are built
from the checkout, differing only by a label (`local.sh` and the job build
them with `build-unit-image.sh`); a PR that changes how a deploy has to go, such as a
different cache, points `IMAGE_A` at the old build instead.

1. fresh start with image A (both units), cache warmed;
2. A -> B (blot-blue is replaced, then blot-green);
3. B -> A (the rollback);
4. A -> B again;
5. B -> A, which must keep the warm cache (the first request after is a HIT),
   then A again, which must replace nothing;
6. a B deploy over A that fails after blot-blue was stopped (Redis is down for
   the whole deploy, so the post-replacement checks fail), with the pages
   changing and the proxy being told while blot-blue is stopped. blot-blue must
   be put back (the same container, renamed back from `-previous`), blot-green
   must be the container it was, and nothing may serve a page that changed.

`swap-load.sh` runs `blue-green.sh` as a user in the docker group with no sudo, as the
Deploy workflow's `deploy` user is (`DEPLOY_AS_ROOT=1` to run it as the
caller), so a deploy step that needs root on the cache files (uid 1000) fails
here; emptying the cache directory on a fresh start goes through a container.

Each deploy runs with `swap-load.js load`: 24 workers sending cached pages
(identity, gzip and brotli), HEAD, conditional GETs, `Range` requests, a 2.5 MB
file, a slow fill, uncached GETs, POSTs of up to 24 MB, 6-second event
streams, and a purge about every 500 ms, as Node sends them. The upstream
(`swap-load-stub.js`) answers with a body that is a function of host, path and
the host's generation, which a "content change" bumps (`swap-load-lib.js`), so
every response is rebuilt and compared byte for byte, and must be from a
generation no older than the last purge that had finished when the request was
sent. A deploy fails on any connection error, any status other than 2xx/304,
any wrong body, any event stream that is cut, any purge that cannot be
delivered, and any stale page (all the containers share one cache directory, so a
purge reaches every one and no stale answer is excused).

After each deploy, with the load stopped, every page of every host must be the
upstream's current generation, and a purge must work (HIT, change and purge,
MISS of the new generation, HIT).

Something the load generator does not hide, printed in the summary:

- A reused keep-alive connection that is reset before any response byte, at
  the moment the old container closes its idle connections, is retried on a new
  connection like any HTTP client retries a GET (`requests reset on an idle
  kept-alive connection and retried`).

### `net.ipv4.tcp_migrate_req` is a host kernel setting

When a container stops it closes its listening sockets (the units share
:80/:443 with `SO_REUSEPORT`), and a connection that has finished its
handshake in that socket's queue but has not been accepted is reset. On a kernel
before 5.14, or one with `net.ipv4.tcp_migrate_req=0` (the default), a swap can
reset a connection or two at a few hundred new connections a second (measured:
49 resets in 65,000 requests over 10 swaps at ~1000 a second; none in 10 swaps
with the setting at 1). That is a property of the host's kernel configuration,
not of the deploy scripts, and **production may not have it set**: the zero
failed requests the CI job asserts depends on it.

`swap-load.sh` therefore sets it to 1 (so that CI does not flake), and with
`TCP_MIGRATE_REQ=0` leaves the host alone and instead **reports** how many new
connections were reset before a response byte, per swap and in total, without
failing on them. Run that way on a host, it tells how many requests a deploy
there would lose.

### Running it

`local.sh` builds both images and runs it all in a privileged Linux container
with a Docker daemon of its own (it works on a Mac with Docker Desktop, where
`--network host` and bind mounts behave differently); `TCP_MIGRATE_REQ=0
bash proxy/deploy/e2e/local.sh` for the resets. On a Linux host with Docker and
sudo, build the images with `build-unit-image.sh` and run `setup.sh` (with
`STUB_JS=$PWD/proxy/deploy/e2e/swap-load-stub.js` and `E2E_UPSTREAMS_FROM_ENV=1`),
`unit-setup.sh` and `swap-load.sh` the way the job does. `build-image.sh` adds the whole address space to the image's
rate-limit whitelist (the load generator is one client); the two images have
different repository names because `blue-green.sh` removes the other tags of the
repository it deployed.

## Why no Pebble

`blue-green.sh` refuses to run unless `redis-cli` is installed and can read a
custom-domain certificate from Redis for every `ssl:*:latest` key
(`cert_baseline` in `common.sh`), which in production come from
`lua-resty-auto-ssl` issuing through Pebble/Let's Encrypt. Actually issuing a
certificate is not on the path the script's own logic exercises - that's
what `try-issuance.sh` is for - so this harness sets `PROXY_SKIP_CERT_SWEEP=1`
rather than standing up Pebble and seeding Redis with a real
`lua-resty-auto-ssl` storage entry, and does not set `PROXY_CUSTOM_DOMAIN`.
`proxy/config/auto-ssl.conf`'s path (the `default_server` block) is
therefore not covered here.

## Forced-failure rollbacks (`unit-deploy-e2e`)

The forced-failure scenarios are deterministic - no timing, no log-line
trigger, no sleep:

- **A unit that never becomes healthy**, because node-a never listens (a unit
  built with `BREAK=a`) or because its proxy exits (blue-green's "renamed" state, where the
  old blot-blue is `blot-blue-previous` and must come back, and blot-green must
  not have been touched, or, on a fresh start, nothing is left behind). The
  forced-failure steps override `PROXY_ENV_FILE` with a copy of the real one
  whose `PROXY_PRIVATE_IP` is `198.51.100.7` (TEST-NET-2, RFC 5737 - never
  assigned to a runner interface). `validate_image()` runs `openresty -t` with
  `ip_nonlocal_bind`, so preflight still passes; only the real container's
  `:8077` listener fails to bind, so it exits immediately and `wait_healthy`
  sees it not running.
- **A healthy new unit whose checks fail** (the rollback must start the old one
  again and remove the new one). A first version of this stopped the stub
  upstream, triggered off the script's own log line. That raced `live_checks`
  for real: with the stub already healthy and a local container that drains in
  well under a second, the window between that log line and `live_checks`
  running was sometimes too narrow even for a log-tailing trigger to reliably
  win. Stopping **Redis** instead, for the whole duration of the
  `blue-green.sh` call, is deterministic: `cert_baseline()` (the only
  redis-cli use in preflight) is skipped by `PROXY_SKIP_CERT_SWEEP=1`, and the
  new unit's health socket doesn't need Redis either, so nothing before the
  replacement notices - only the post-replacement `live_checks()`, which does
  call `redis_reachable()`, fails, regardless of how fast the drain and check
  happen to run.
- **The other unit is unhealthy** (blot-blue must not be stopped). The health
  socket file is removed from blot-green: nginx keeps serving on its open
  listening socket, but the deploy's health check, which goes to that socket,
  fails.

## Why `BLOT_HOST=blot.im`

The image's virtual hosts are generated for `blot.im`
(`proxy/build/build.sh` defaults `BLOT_HOST` to it), so the harness's
certificate and requests use the same name. Nothing here makes a real request
to the real `blot.im`: every check either connects straight to `127.0.0.1`
(`curl --connect-to`, `openssl s_client -connect 127.0.0.1:...`) or runs inside
a container on `--network host`.
