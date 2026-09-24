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

## Why `BLOT_HOST=blot.im`

`config/openresty/locals.js`'s `baremetal()` hardcodes `host: "blot.im"`
regardless of `BLOT_HOST` in the environment (the container side reads
`env.BLOT_HOST`, the bare-metal generator does not) - this harness has to use
the same value on both sides for the bare-metal container's `server_name` to
match. Nothing here makes a real request to the real `blot.im`: every check
either connects straight to `127.0.0.1` (`curl --connect-to`,
`openssl s_client -connect 127.0.0.1:...`) or runs inside a container on
`--network host`.
