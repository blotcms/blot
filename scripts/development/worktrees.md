# Worktree preview stacks

Local agents work in git worktrees. The Docker stack bind-mounts the **main
checkout**, so `https://local.blot` never shows the agent's code. The current
workaround — duplicate the branch and check it out in the main tree — should
not be necessary.

This is a plan, not an implementation.

## Recommendation

A **fixed pool of five sibling hosts**, prepared in advance:

| Slot | `BLOT_HOST` | Dashboard | Blog | CDN |
|------|-------------|-----------|------|-----|
| a | `a-local.blot` | `https://a-local.blot` | `https://example.a-local.blot` | `https://cdn.a-local.blot` |
| b | `b-local.blot` | … | … | … |
| c–e | same pattern | | | |

Each claimed slot is **one extra Node container** (worktree bind-mount, no
host ports). nginx, Redis, `data/`, and airlock stay shared with `npm start`.
The sidecar is **not master**.

Agents do **not** get a stack automatically. A skill claims a free slot,
prints the URLs, and releases the slot when the session ends.

That is just `BLOT_HOST=<slot>-local.blot`. Express already derives dashboard,
CDN, blogs, and `preview-of-…` hosts from `config.host`. No vhost rewrite.

## Why a sibling host beats a nested subdomain

`BLOT_HOST=my-feature.wt.local.blot` looked neat until TLS and nginx:

- mkcert today signs `local.blot` + `*.local.blot`.
- `*.local.blot` covers `example.local.blot`, **not** `example.my-feature.wt.local.blot` (two labels).
- nginx wildcards are only leftmost (`*.example.com`). Nested names force regex + variable `proxy_pass` + Docker DNS.

`BLOT_HOST=a-local.blot` is the same *shape* as production/`local.blot`:

| | Main | Slot a |
|---|---|---|
| Apex | `local.blot` | `a-local.blot` |
| One-level wildcard | `*.local.blot` | `*.a-local.blot` |

`cdn.a-local.blot`, `example.a-local.blot`, and
`preview-of-blog-on-example.a-local.blot` are all **one** label under
`a-local.blot`. Existing `extractHandle` / `vhost(config.host)` logic works
unchanged.

dnsmasq `address=/blot/127.0.0.1` already answers every name under `.blot`.
`a-local.blot` and `cdn.a-local.blot` need no DNS change.

Branch-named hosts (`dark-mode-local.blot`) are nicer to read but need a new
cert SAN and nginx `server_name` per branch. With a cap of five concurrent
forks, letters are enough. The skill prints which slot maps to which
worktree/branch.

`a.local.blot` is worse than `a-local.blot`: the dashboard would be covered
by `*.local.blot`, but `example.a.local.blot` is nested again.

## How local.blot works today

```
browser
  → dnsmasq  (address=/blot/127.0.0.1)
  → nginx    :80/:443  TLS via mkcert
       proxy_set_header Host $host
  → node-app :8080  (nodemon, bind-mounted main checkout)
  → redis    :6379  (./data/redis)
  → airlock
```

- Compose project name is hardcoded `name: blot`. A second `docker compose up`
  from a worktree **replaces** those containers.
- Host ports 80, 443, 8080, 6379 are published once.
- `config.master` is `CONTAINER_NAME === "blot-container-green"`. Only master
  builds SITE templates into Redis, starts the scheduler, and inits clients
  (folder watchers). Sidecars must use any other `CONTAINER_NAME`.
- Dashboard cookies are host-only (`domain: ""`). A login on `local.blot`
  does not apply to `a-local.blot`. `configure-local-blogs.js` already prints
  a one-time login URL for `config.host`.
- `fork.sh` already resolves `data/` via `git rev-parse --git-common-dir`.

Cloud Agent VMs are out of scope: each already has its own `https://local.blot`.

## Share vs isolate

Same as before: own Node, share nginx / Redis / `data/` / airlock, skip
toxiproxy, main stack stays master.

Sidecar writes (dashboard POST, template-editor save) hit the **shared**
database. Folder sync and SITE-template rebuild still run in the main
process — a worktree that only changes `app/sync` or `app/templates/source`
will not exercise that code. Dashboard/docs/CSS/JS and blog *render* code
will.

Do not build isolated Redis until this pool is in daily use.

## Pool, claim, release

Five slots, prepared once. Not one stack per worktree, and not an
auto-watcher on `git worktree list`.

| Slot | Host | Compose project | Container |
|------|------|-----------------|-----------|
| a | `a-local.blot` | `blot-a` | `blot-node-a` |
| b | `b-local.blot` | `blot-b` | `blot-node-b` |
| c–e | … | `blot-c` … | `blot-node-c` … |

**Claim.** The skill (or `scripts/development/worktree-up.sh`) walks a→e and
takes the first free slot. `container_name: blot-node-a` is the mutex:
`docker run` / compose fails if the name exists. Metadata (worktree path,
branch, started-at) goes in a label and/or `data/worktree-slots/<slot>.json`
so `worktree-up.sh` / `docker ps` can show who holds what.

A slot is **free** when there is no `blot-node-<slot>` container.

A slot is **stealable** when the container exists but the recorded worktree
path is gone (agent crashed, worktree removed). The next claimer downs it
and reuses the slot. Do not steal a live worktree without `--steal`.

**Release.** The same skill, at the end of the session, runs
`docker compose -p blot-<slot> down` and deletes the metadata file. Agents
will not always remember; steal-if-worktree-gone plus an operator
`worktree-down --all` covers leftovers. `start.sh` Ctrl-C should down
sidecars too (otherwise they sit on a dead Redis) — that is cleanup of the
*pool*, not auto-start.

If all five are claimed and none are stealable, the skill stops and says so.
Do not mint `f-local.blot` on the fly.

## TLS and nginx (all static, all in advance)

mkcert SANs in `config/openresty/setup.sh`:

```
local.blot      *.local.blot
a-local.blot    *.a-local.blot
b-local.blot    *.b-local.blot
c-local.blot    *.c-local.blot
d-local.blot    *.d-local.blot
e-local.blot    *.e-local.blot
```

`setup.sh` must regenerate when those SANs are missing (today it returns
early if `data/ssl` exists). One cert, one time. No mkcert per agent.

nginx: five ordinary server blocks, not regex, not variable `proxy_pass`:

```nginx
upstream blot_node_a { server blot-node-a:8080; }

server {
    listen 443 ssl;
    server_name a-local.blot *.a-local.blot;
    ssl_certificate     /etc/ssl/certs/wildcard.crt;
    ssl_certificate_key /etc/ssl/private/wildcard.key;
    location / {
        proxy_pass http://blot_node_a;
        # same Host / proto / body-size headers as the default server
    }
}
```

Repeat for b–e. Missing container → 502. No reload when a slot is claimed.
The existing `default_server` keeps `local.blot` / `*.local.blot`.

`:80` already 301s to `https://$host$request_uri`. Fine as-is.

No handle ban needed: `a-local` is not a label under `local.blot`.

## Compose overlay

`scripts/development/docker-compose.worktree.yml`, parameterized by `SLOT`:

- project `blot-${SLOT}`, container `blot-node-${SLOT}`
- network `blot_default` `external: true`
- `image: blot` (rebuild only if Dockerfile/`package.json` changed)
- no `ports`
- ~512–768m RAM, ~0.25 CPU, smaller `--max-old-space-size`
- `BLOT_HOST=${SLOT}-local.blot`
- `CONTAINER_NAME=blot-container-${SLOT}` (not green → not master)
- `BLOT_REDIS_HOST=redis`, same `BLOT_AIRLOCK_*` as main
- volumes: **this worktree's** `app`, `config`, `scripts`, `tests`;
  **main checkout's** `data/` and `.env` (`git-common-dir`)
- nodemon as in the main compose file
- no redis / nginx / toxiproxy / airlock services

Quiet boot: skip `email.SERVER_START` when not master. Keep
`configureLocalBlogs()` so the login URL is for `https://a-local.blot`.

## Skill (opt-in, not automatic)

Do not watch worktrees from `npm start`. Most agents never need a sidecar.

Add a skill, e.g. `.claude/skills/preview-worktree/SKILL.md`, used when the
operator needs to **see or click around** this worktree's running server.

The skill should be short and mechanical:

1. If `https://local.blot/health` fails, stop. Ask the operator to run
   `npm start`. Do not try to become the main stack (`name: blot`).
2. From this worktree, run `scripts/development/worktree-up.sh`.
3. Use only the printed hosts (`https://<slot>-local.blot`,
   `https://<handle>.<slot>-local.blot`) and container
   (`blot-node-<slot>`) for `access.js` / `info` / browser checks.
   Do not send the operator to `https://local.blot` for this worktree's
   code, and do not ask them to check the branch out.
4. When the session is done — task complete, or the operator no longer
   needs the preview — run `scripts/development/worktree-down.sh` so the
   slot goes back in the pool.

`worktree-up.sh` (called from the skill, never from a boot watcher):

- resolve worktree root and main `data/` via `git-common-dir`
- refuse to run in the main checkout (that *is* `local.blot`)
- claim a→e as above
- `docker compose -p blot-<slot> -f docker-compose.worktree.yml up -d`
- wait for `/health` on the slot host
- print dashboard URL, example-blog URL, access command, slot letter

`app/views/AGENTS.md` and `app/templates/AGENTS.md` stay as they are for
the common case (`https://local.blot`). Point at the skill instead of
telling every agent to spin up a fork.

## What this does not solve

- Cloud Agent VMs (already isolated).
- Sync / SITE-template / scheduler / Redis-schema changes in a worktree.
- Native-module / `package.json` changes (shared `blot` image).
- More than five concurrent previews.

## Implementation sequence

1. Cert SANs for a–e + regenerate-if-missing in `setup.sh`.
2. Five nginx `server_name` blocks in `development_server.conf`.
3. `docker-compose.worktree.yml` + `worktree-up.sh` / `worktree-down.sh`
   (claim, steal-if-orphaned, `--steal`, `--all`).
4. Skip `SERVER_START` email when not master.
5. Skill `preview-worktree`. No change to `start.sh` except optional
   sidecar teardown on Ctrl-C.
6. Smoke: `local.blot` unchanged; claim a; log in on `a-local.blot`;
   `example.a-local.blot` renders worktree code; nodemon picks up an
   edit; down releases the slot; second claim gets `a` again; fifth
   succeeds, sixth refuses.

No production deploy. Local Docker + one cert regen.

## Alternatives considered

- **Nested `*.wt.local.blot`.** Works, but needs nested-wildcard certs and
  regex nginx. Sibling `a-local.blot` is the same `BLOT_HOST` trick with
  none of that.
- **Branch-named `my-feature-local.blot`.** Same sibling shape, unbounded
  SANs/server_names. Not worth it for five seats.
- **Auto-start every worktree.** Wastes RAM; most agents never need HTTP.
  Skill + pool is the whole point of a cap of five.
- **Full compose clone per slot** (own Redis/nginx). Empty data, port
  fights, extra Chromium.
- **Path-based** (`local.blot/__wt/…`). Fights `vhost(config.host, site)`.
- **Bind-mount worktree `app/` over the main container.** One at a time;
  same as checking the branch out.
