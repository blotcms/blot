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
| `config/` | Source `.conf` / `.lua` files (a hand-maintained fork of `config/openresty/conf`). |
| `build/index.js` | Renders `config/server.conf` + partials into a single `openresty.conf`. |
| `build/build.sh` | Wrapper that runs `build/index.js` with the container's paths. Run this before `docker build`. |
| `build/data/latest/` | Generated output (git-ignored). |
| `Dockerfile` | Two-stage build: vendors the Lua deps, then assembles the image. |
| `entrypoint.sh` | Validates `BLOT_HOST` and a certificate is present, then starts OpenResty. |
| `tests/` | Cache (`cacher.lua`) behaviour specs. Run as the `proxy` suite in the `node` workflow's test matrix, same as `config/openresty`. |
| `e2e/` | Full-stack checks driven through the built image (stub upstream + a real Blot app container). Run by the `integration` workflow. |

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

`--cap-add SYS_NICE` avoids a harmless `setpriority(-20) failed` alert from
`worker_priority` in an unprivileged container.

CI runs the same steps in [`.github/workflows/proxy.yml`](../.github/workflows/proxy.yml)
on any change under `proxy/` (plus `package.json` and `config/index.js`, which
the generator reads).

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

This is build-only scaffolding: nothing here is deployed, and it does not yet
replace `config/openresty`. The remaining work - certificate issuance for
custom domains, zero-downtime deployment, de-duplicating `proxy/config`
against `config/openresty/conf`, persistent cache/cert volumes, and hardening
the real-app e2e - is tracked in the repo's `TODO` file under
"Proxy container (OpenResty)".

## Tests

- **`proxy` suite** (`.github/workflows/node.yml` test matrix) runs
  `proxy/tests/*.js` inside the Blot dev image, spinning up OpenResty against
  `proxy/config` - the `cacher.lua` behaviour specs (`basic`, `gzip`,
  `inspect`, `lru_purge`, `rehydrate`, plus `coverage` for per-host keys,
  method/health cacheability, binary bodies and argument validation).
- **`integration` workflow** (`.github/workflows/integration.yml`):
  - `proxy/e2e/checks.sh` drives the built image against
    `proxy/e2e/stub-upstream.js` - Host-based routing (site over HTTPS, blogs
    and custom domains over HTTP), `/.git` and `wp-*` blocking, `Blot-Cache`
    MISS then HIT, gzip negotiation, upstream-error handling.
  - `proxy/e2e/run.js` brings the image up with the Blot app image + Redis
    (`proxy/e2e/docker-compose.yml`) and goes through the proxy end to end:
    the site loads, the sign-in page renders, and a seeded user signs in,
    reaches the dashboard, and signs out.
