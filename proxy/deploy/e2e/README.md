# Real-Docker end-to-end tests for the proxy deploy scripts

`proxy/deploy/tests/run.sh` drives `blue-green.sh` against fake
`docker`/`curl`/`systemctl`/`openssl` to check the order of operations. This
directory instead runs the **real** script against **real** Docker and Redis,
in `.github/workflows/proxy-deploy-e2e.yml`.

The harness starts with no proxy container running, so the first scenario is
the fresh start `blue-green.sh` does when nothing is serving, and the rest
swap colours from there. (The one-off move from the bare-metal OpenResty to
the first container, a one-off script, ran on 8 Oct 2026 under
[#1941](https://github.com/blotcms/blot/issues/1941) and was deleted along
with the bare-metal stand-in this harness used to need.)

## What's here

- `gen-certs.sh` - a self-signed CA plus a wildcard leaf certificate for
  `BLOT_HOST`, trusted in the runner's CA store so `curl`'s ordinary
  certificate validation (`https_status` in `proxy/deploy/common.sh`) passes.
- `setup.sh` - brings up Redis, the stub upstream
  (`proxy/e2e/stub-upstream.js`) and a fake Node container
  (`blot-container-blue`, the purge probe target), and writes the
  `proxy.env` files the scenarios use.

## Swapping an image under load

`proxy-swap-load-e2e` (same workflow, own job) runs `swap-load.sh`: one image
swapped for another by the real `blue-green.sh`, against real Docker, Redis and
a stub upstream, while a load generator never stops. Every proxy deploy is
rehearsed this way, so a change that would drop, reset, corrupt or leave stale a
request during a deploy shows up here first. By default both images are built
from the checkout, differing only by a label (`local.sh` and the job build
them with `build-image.sh`); a PR that changes how a deploy has to go, such as a
different cache, points `IMAGE_A` at the old build instead.

1. fresh start with image A, cache warmed;
2. A -> B;
3. B -> A (the rollback);
4. A -> B again;
5. B -> B, which must keep the warm cache (the first request after is a HIT);
6. a B -> A swap that fails after B was stopped (Redis is down for the whole
   deploy, so the post-swap checks fail), with the pages changing and the
   proxy being told while B is stopped. B must be put back and must not serve a
   page that changed.

`swap-load.sh` runs `blue-green.sh` as a user in the docker group with no sudo, as the
Deploy proxy workflow's `deploy` user is (`DEPLOY_AS_ROOT=1` to run it as the
caller), so a deploy step that needs root on the cache files (uid 1000) fails
here; `drop_overlap_cache` deletes them through a root container instead.

Each swap runs with `swap-load.js load`: 24 workers sending cached pages
(identity, gzip and brotli), HEAD, conditional GETs, `Range` requests, a 2.5 MB
file, a slow fill, uncached GETs, POSTs of up to 24 MB, 6-second event
streams, and a purge about every 500 ms, as Node sends them. The upstream
(`swap-load-stub.js`) answers with a body that is a function of host, path and
the host's generation, which a "content change" bumps (`swap-load-lib.js`), so
every response is rebuilt and compared byte for byte, and must be from a
generation no older than the last purge that had finished when the request was
sent. A swap fails on any connection error, any status other than 2xx/304,
any wrong body, any event stream that is cut, any purge that cannot be
delivered, and any stale page outside the window below.

After each swap, with the load stopped, every page of every host must be the
upstream's current generation, and a purge must work (HIT, change and purge,
MISS of the new generation, HIT).

Things the load generator does not hide, all printed in the summary:

- A reused keep-alive connection that is reset before any response byte, at
  the moment the old container closes its idle connections, is retried on a new
  connection like any HTTP client retries a GET (`requests reset on an idle
  kept-alive connection and retried`).
- While both containers are up (from the new one starting to the old one
  stopping, about two seconds) a purge reaches only one of them, the limitation
  documented in `blue-green.sh`: each keeps its list of what to delete in its own
  memory, so a page one cached after the other rebuilt its list is unknown to the
  other. A page purged in that window can be served until the old container
  stops. These are counted apart (`stale answers while both containers were up`)
  and tolerated only inside that window.

### `net.ipv4.tcp_migrate_req` is a host kernel setting

When a container stops it closes its listening sockets (both colours share
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
sudo, build the images with `build-image.sh` and run `setup.sh` (with
`STUB_JS=$PWD/proxy/deploy/e2e/swap-load-stub.js`) and `swap-load.sh` the way the
job does. `build-image.sh` adds the whole address space to the image's
rate-limit whitelist (the load generator is one client); the two images have
different repository names because `blue-green.sh` removes the other tags of the
repository it deployed.

## The legacy <-> disk cache transition

`proxy-transition-e2e` (same workflow, own job) runs `transition.sh`: the swap
a host makes the first time it deploys an image with `diskcache.lua` (and the
swap back, if it has to roll back), with real images of both kinds, the real
`blue-green.sh`, and a load generator that does not stop:

1. fresh start with the legacy image (the last `master` commit with
   `cacher.lua`, pinned as `LEGACY_REF` in the workflow), cache warmed;
2. legacy -> disk;
3. disk -> legacy (the rollback);
4. legacy -> disk again, over the stale cache directory an older
   `blue-green.sh` would have left behind (a copy of the previous contents,
   put back after the swap, with a marker file);
5. disk -> disk, which must keep the warm cache (the first request after is a
   HIT).

Each swap runs with `transition.js load`: 24 workers sending cached pages
(identity, gzip and brotli), HEAD, conditional GETs, `Range` requests, a 2.5 MB
file, a slow fill, uncached GETs, POSTs of up to 24 MB, 6-second event
streams, and a purge about every 500 ms, as Node sends them. The upstream
(`transition-stub.js`) answers with a body that is a function of host, path and
the host's generation, which a "content change" bumps (`transition-lib.js`), so
every response is rebuilt and compared byte for byte, and must be from a
generation no older than the last purge that had finished when the request was
sent. A swap fails on any connection error, any status other than 2xx/304,
any wrong body, any event stream that is cut, any purge that cannot be
delivered, and any stale page outside the window below.

Between swaps it checks that the new kind's cache directory was emptied
before the new container was created (the log order, and a marker file),
that the old kind's was emptied after the commit, that a page the old cache held
and the upstream had since changed *without* a purge is not served, that
every page of every host is the upstream's current generation once the load
stops, and that a purge works (HIT, change and purge, MISS of the new
generation, HIT).

Two things the load generator does not hide, both printed in the summary:

- A reused keep-alive connection that is reset before any response byte, at
  the moment the old container closes its idle connections, is retried on a new
  connection like any HTTP client retries a GET (`requests reset on an idle
  kept-alive connection and retried`).
- While a legacy and a disk container are both up (from the new one starting to
  the old one stopping, about two seconds) they do not share a cache and a purge
  reaches only one of them, the limitation documented in `blue-green.sh`. A page
  purged in that window can still be served by the container that did not get the
  purge, until it stops (`stale answers while both kinds of container were up`).
  Only those, only in a swap between kinds, are tolerated; the swap of the same
  kind (a shared directory) tolerates none.

A third thing is not about the deploy scripts at all: when a container stops
it closes its listening sockets, and a connection that has finished its
handshake in that socket's queue but has not been accepted is reset. On a kernel
before 5.14, or one with `net.ipv4.tcp_migrate_req=0` (the default), a swap
resets a connection or two at a few hundred new connections a second (measured:
49 resets in 65,000 requests over 10 swaps at ~1000 a second; none in 10 swaps
with the setting at 1). `transition.sh` sets it to 1 (`TCP_MIGRATE_REQ=0` to
see the resets), because that is the setting a zero-failed-requests deploy needs
on the host.

Locally, `TEST=transition bash proxy/deploy/e2e/local.sh` builds both images
and runs it the way `local.sh` runs `swap-load.sh` (see "Running it" above); on
a Linux host with Docker and sudo, build the images with `build-image.sh` and
run `setup.sh` (with `STUB_JS=$PWD/proxy/deploy/e2e/transition-stub.js`) and
`transition.sh` the way the job does. `build-image.sh` adds the
whole address space to the image's rate-limit whitelist (the load generator is
one client); the two images have different repository names because
`blue-green.sh` removes the other tags of the repository it deployed.

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

## Forced-failure rollbacks

Both forced-failure scenarios are deterministic - no timing, no log-line
trigger, no sleep:

- **A container that never becomes healthy** (blue-green's "starting" state,
  where the old colour is never touched, or, on a fresh start, nothing is left
  behind). The forced-failure steps override `PROXY_ENV_FILE` with a copy of
  the real one whose `PROXY_PRIVATE_IP` is `198.51.100.7` (TEST-NET-2, RFC
  5737 - never assigned to a runner interface). `validate_image()` runs
  `openresty -t` with `ip_nonlocal_bind`, so preflight still passes; only the
  real container's `:8077` listener fails to bind, so it exits immediately and
  `wait_healthy` sees it not running.
- **A healthy new colour whose post-swap checks fail** (blue-green's
  "swapping" state, where the old colour was already stopped and must be
  restarted). A first version of this stopped the stub upstream, triggered
  off the script's own "Draining and stopping" log line. That raced
  `live_checks` for real: with the stub already healthy and a local
  container that drains in well under a second, the window between that
  log line and `live_checks` running was sometimes too narrow even for a
  log-tailing trigger to reliably win - the swap occasionally completed
  successfully before the stub could be stopped. Stopping **Redis**
  instead, for the whole duration of the `blue-green.sh` call, is
  deterministic: `cert_baseline()` (the only redis-cli use in preflight) is
  skipped by `PROXY_SKIP_CERT_SWEEP=1`, and the new colour's health socket
  doesn't need Redis either, so nothing before the swap notices - only the
  post-swap `live_checks()`, which does call `redis_reachable()`, fails,
  regardless of how fast the drain and check happen to run.

## Why `BLOT_HOST=blot.im`

The image's virtual hosts are generated for `blot.im`
(`proxy/build/build.sh` defaults `BLOT_HOST` to it), so the harness's
certificate and requests use the same name. Nothing here makes a real request
to the real `blot.im`: every check either connects straight to `127.0.0.1`
(`curl --connect-to`, `openssl s_client -connect 127.0.0.1:...`) or runs inside
a container on `--network host`.
