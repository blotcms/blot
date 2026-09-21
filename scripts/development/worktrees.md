# Worktree previews

The Docker stack bind-mounts the **main checkout**, so `https://local.blot`
never shows a worktree's code. `preview.sh` runs a worktree in its own Node
container instead, so it can be opened in the browser without checking the
branch out in the main tree.

```
scripts/development/preview.sh up [url-or-path]   # claim a slot (or reuse this worktree's), print login + work URLs
scripts/development/preview.sh down   # release it
scripts/development/preview.sh ls     # who holds which slot
```

`up` prints a one-time dashboard **Login** URL (generated with `scripts/blog/access.js`
inside the sidecar) and a **Work** URL: the page you pass, as a path
(`/sites/local`) or a `local.blot` URL, rewritten to the slot host
(`https://preview-of-blog-on-local.local.blot/` becomes
`https://preview-of-blog-on-local.a-local.blot/`). Agents should always pass
the page they are working on (a docs page, a template preview, …).

Requires `npm start` to be running. Refuses to run in the main checkout.

## How it works

Five fixed sibling hosts, `a-local.blot` … `e-local.blot`. Each claimed slot is
one extra container, `blot-node-<slot>`, with this worktree's `app`, `config`,
`scripts` and `tests` mounted (nodemon reloads on edit). nginx, Redis, `data/`
and airlock are shared with the main stack.

`BLOT_HOST=<slot>-local.blot` is all the app needs: dashboard
(`https://a-local.blot`), CDN, blogs (`https://example.a-local.blot`) and
`preview-of-…` hosts are all derived from `config.host`.

Sibling hosts rather than `*.wt.local.blot`: `*.local.blot` does not cover
`example.x.local.blot` (two labels), and nested names would need nested
wildcard certs. `a-local.blot` has the same shape as `local.blot`, so one
wildcard per slot works. dnsmasq already answers everything under `.blot`.

- **TLS:** `config/openresty/setup.sh` adds `a-local.blot`/`*.a-local.blot` …
  to the mkcert cert and regenerates an existing cert that lacks them.
- **nginx:** one regex `server` block in `development_server.conf` sends
  `[a-e]-local.blot` (and subdomains) to `blot-node-<slot>:8080`. It uses a
  variable `proxy_pass` with Docker's resolver, so nginx boots with no sidecars
  and a free slot returns 502. Nothing reloads on claim.
- **Compose:** `docker-compose.worktree.yml`, project `blot-<slot>`, joined to
  the `blot_default` network, no published ports, 768m / 0.25 CPU,
  `CONTAINER_NAME=blot-container-<slot>` so it is **not master**.
- **State lives only in Docker.** The container name is the mutex and a
  `blot.worktree` label holds the worktree path. `up` reuses this worktree's
  slot, otherwise removes sidecars whose worktree directory no longer exists,
  then takes the first free letter. If all five are held it stops and lists them.
- Dashboard cookies are host-only, so log in on each slot; `up` prints the
  `access.js` command.
- Sidecars skip the `SERVER_START` email (`app/index.js`).

## Limits

Sidecars share the live dev database, so:

- Dashboard/template-editor writes from a slot change data `local.blot` also
  sees.
- Do not use a slot to test Redis-schema changes.
- Folder sync and the scheduler only run in the main (master) process, so
  changes under `app/sync` or `app/clients` are not exercised. Dashboard, docs,
  CSS/JS and blog rendering are.
- Slots also build and watch SITE templates (`BLOT_BUILD_TEMPLATES=true`), so
  edits under `app/templates/source` rebuild on the slot. Templates live in
  the shared dev Redis: a slot's startup build overwrites every template with
  this worktree's copy, and its rebuilds show on `local.blot` and other slots
  too. Last writer wins; expect one agent to edit one template.
- Native-module or `package.json` changes need a rebuilt `blot` image.
- Cloud Agent VMs already have their own `local.blot`.
- At most five concurrent previews.
- Memory: the Docker VM is small (~2 GB here). A running sidecar (up to 768m)
  on top of the main stack can push it into OOM; during testing the main
  `node-app` was OOM-killed with one sidecar running. Release slots when done.

Unverified: whether anything cached in shared Redis embeds `config.host`
(rendered blog output, CDN URLs). If so, slots would need a cache namespace.

## Alternatives considered

- **Nested `*.wt.local.blot`.** Needs nested wildcard certs and regex nginx.
- **Branch-named hosts.** Unbounded cert SANs / server names.
- **Auto-start per worktree.** Wastes RAM; most agents never need HTTP.
- **Full compose clone per worktree.** Empty data, port clashes.
- **Path-based (`local.blot/__wt/…`).** Fights `vhost(config.host, site)`.
- **Bind-mount worktree over the main container.** One at a time.
