# Real-Docker end-to-end tests for the proxy deploy scripts

`proxy/deploy/tests/run.sh` drives `cutover-from-baremetal.sh` and
`blue-green.sh` against fake `docker`/`curl`/`systemctl`/`openssl` to check
the order of operations. This directory instead runs the **real** scripts
against **real** Docker, Redis, and a systemd-managed container standing in
for the bare-metal `openresty` unit, in `.github/workflows/proxy-deploy-e2e.yml`.

## What's here

- `gen-certs.sh` - a self-signed CA plus a wildcard leaf certificate for
  `BLOT_HOST`, trusted in the runner's CA store so `curl`'s ordinary
  certificate validation (`https_status` in `proxy/deploy/common.sh`) passes.
- `build-baremetal-config.sh` / `baremetal.Dockerfile` - build a container
  from the bare-metal OpenResty config (`config/openresty`), standing in for
  the `openresty` systemd unit. **Copied from
  `proxy/differential/{build-baremetal-config.sh,baremetal.Dockerfile}`**
  (sibling PR [#1977](https://github.com/blotcms/blot/pull/1977), branch
  `claude/proxy-differential-tests`) rather than depended on, so this harness
  doesn't need that PR merged first. Whichever of the two merges second
  should dedupe them (and `config/openresty/build-config.js`'s
  `FETCH_CDN_IPS=false` escape hatch, added by both branches independently).
- `setup.sh` - brings up Redis, the stub upstream
  (`proxy/e2e/stub-upstream.js`), a fake Node container
  (`blot-container-blue`, purge probe target), the bare-metal container, and
  a real systemd unit (`openresty.service`) that wraps `docker start`/`docker
  stop` of it.
- `reset-baremetal.sh` - between scenarios, removes any leftover
  `blot-proxy-*` container and re-enables/starts the bare-metal unit.

## Why a systemd unit instead of a `systemctl` shim

`common.sh`'s `sys()` runs privileged commands (`systemctl`) via `sudo -n`
when not root, and `sudo` resets `PATH` to its `secure_path`, so a custom
`systemctl` script placed outside that path would never be found - a real
concern for a hand-rolled shim. GitHub-hosted `ubuntu-latest` runners are
full VMs already running systemd, with a genuine, already-on-`secure_path`
`systemctl` and passwordless sudo for the runner user. A unit
(`openresty.service`) whose `ExecStart`/`ExecStop` are `docker start`/`docker
stop` of the bare-metal container gets exactly the behaviour a shim would
fake (`start`, `stop`, `enable`, `disable`, `is-active`, `is-enabled` all
genuinely work) with no `PATH` workaround and no separate state file for
enabled/disabled.

## Why no Pebble

Both scripts refuse to run unless `redis-cli` is installed and can read a
custom-domain certificate from Redis for every `ssl:*:latest` key
(`cert_baseline` in `common.sh`), which in production come from
`lua-resty-auto-ssl` issuing through Pebble/Let's Encrypt. Actually issuing a
certificate is not on the path either script's own logic exercises - that's
what `try-issuance.sh` is for - so this harness sets `PROXY_SKIP_CERT_SWEEP=1`
rather than standing up Pebble and seeding Redis with a real
`lua-resty-auto-ssl` storage entry, and does not set `PROXY_CUSTOM_DOMAIN`.
`config/openresty`'s `auto-ssl.conf` path (the `default_server` block) is
therefore not covered here.

## Forced-failure rollbacks

Both forced-failure scenarios are deterministic - no timing, no log-line
trigger, no sleep:

- **A container that never becomes healthy** (cutover's rollback, and
  blue-green's "starting" state, where the old colour is never touched).
  The forced-failure steps override `PROXY_ENV_FILE` with a copy of the
  real one whose `PROXY_PRIVATE_IP` is `198.51.100.7` (TEST-NET-2, RFC 5737
  - never assigned to a runner interface). `validate_image()` only runs
  `openresty -t` (parses the config, never binds), and the cutover
  rehearsal always overrides `PROXY_PRIVATE_IP=127.0.0.1` for its own
  container, so preflight and the rehearsal both still pass; only the real
  container's `:8077` listener fails to bind, so it exits immediately and
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

`config/openresty/locals.js`'s `baremetal()` hardcodes `host: "blot.im"`
regardless of `BLOT_HOST` in the environment (the container side reads
`env.BLOT_HOST`, the bare-metal generator does not) - this harness has to use
the same value on both sides for the bare-metal container's `server_name` to
match. Nothing here makes a real request to the real `blot.im`: every check
either connects straight to `127.0.0.1` (`curl --connect-to`,
`openssl s_client -connect 127.0.0.1:...`) or runs inside a container on
`--network host`.
