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
