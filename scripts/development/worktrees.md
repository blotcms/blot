# Worktree preview stacks

Local agents work in git worktrees. The Docker stack bind-mounts the **main
checkout**, so the browser at `https://local.blot` never shows the agent's
code. The current workaround — duplicate the branch and check it out in the
main tree — should not be necessary.

This is a plan, not an implementation.

## Recommendation

Yes: each worktree gets **its own Node container**. One shared OpenResty/nginx
on :80/:443 routes `https://<slug>.wt.local.blot` (and its blog/CDN/preview
hosts) to that container.

Share **nginx, Redis, the data dir, and airlock**. Do not give worktrees their
own Redis, nginx, or `data/` copy in v1.

Worktree Node processes are **not master**: no scheduler, no client folder
watchers, no SITE-template rebuild into Redis. They serve HTTP against the
same blogs and sessions the main stack already has. Nodemon still watches the
worktree's `app/`.

That is enough to click around the dashboard, docs, and blogs running the
agent's code, without checking the branch out.

## How local.blot works today

```
browser
  → dnsmasq  (address=/blot/127.0.0.1)     # every *.blot name
  → nginx    :80/:443  TLS via mkcert      # scripts/development/docker-compose.yml
       proxy_set_header Host $host
  → node-app :8080  (nodemon, bind-mounted source)
  → redis    :6379  (volume ./data/redis)
  → airlock  (shared Chromium + egress proxy)
```

- Compose project name is hardcoded: `name: blot` in
  `scripts/development/docker-compose.yml`. A second `docker compose up` from
  another directory **replaces the same containers**.
- Host ports 80, 443, 8080, 6379 are published once. A naive second stack
  cannot bind them.
- Volumes are relative to the compose file (`../../app`, `../../data`, …), so
  they follow whichever checkout you start from — but the project name and
  ports stop you from starting a second one.
- `BLOT_HOST` defaults to `local.blot` (`scripts/development/start.sh`).
  Express already keys the dashboard, CDN, and blogs off that value:

  | Role        | Host |
  |-------------|------|
  | Dashboard   | `{BLOT_HOST}` |
  | CDN         | `cdn.{BLOT_HOST}` |
  | Blog        | `{handle}.{BLOT_HOST}` |
  | Preview     | `preview-of-…-on-{handle}.{BLOT_HOST}` |

  Setting `BLOT_HOST=my-feature.wt.local.blot` on a sidecar Node process is
  enough for vhosts. No Express routing change is required.
- mkcert currently signs `local.blot` and `*.local.blot` only
  (`config/openresty/setup.sh`). One-level wildcards do **not** cover
  `example.my-feature.wt.local.blot`.
- dnsmasq already answers every name under `.blot`. Extra labels need no DNS
  change.
- Blog handles are `[a-z0-9]+` with no hyphens
  (`app/models/blog/validate/handle.js`). `www`, `cdn`, `webhooks`, `preview`
  are banned. The label `wt` is **not** banned yet.
- `config.master` is `CONTAINER_NAME === "blot-container-green"`. Only master
  builds SITE templates into Redis, starts the scheduler, and inits clients
  (local-folder chokidar, Dropbox, …). See `app/setup.js`.
- Dashboard cookies are host-only (`domain: ""` in
  `app/dashboard/util/session.js`), so a login on `local.blot` does not apply
  to `my-feature.wt.local.blot`. `configure-local-blogs.js` already prints a
  one-time login URL for `config.host`.
- `scripts/development/fork.sh` already resolves `data/` via
  `git rev-parse --git-common-dir` so worktrees share the main checkout's blog
  folders. The HTTP stack does not.

Cloud Agent VMs (`scripts/cursor/*`) are a different machine each, with their
own `https://local.blot`. This plan is for **local agents on the operator's
machine**, sharing one Docker daemon with `npm start`.

## Why worktrees are invisible

1. Nodemon inside `blot-node-app-1` watches the main checkout's `app/`.
2. Agent writes land in a linked worktree (`git worktree list`).
3. `https://local.blot` keeps serving main-checkout code.
4. Compose `name: blot` plus published ports make "just compose up in the
   worktree" destroy or fight the running stack.

## Share vs isolate

| Piece | v1 | Why |
|---|---|---|
| **Node container** | **Own** | The whole point: bind-mount that worktree's `app/`, `config/`, `scripts/`, `tests/`. Reuse the already-built `blot` image. No host port. |
| **nginx** | **Share** | Only one process can own :443. Route by `Host`. Dev nginx is stock `nginx:alpine` (`config/openresty/Dockerfile`), not OpenResty — regex `server_name` + Docker DNS is enough. |
| **Redis** | **Share** | Same blogs, entries, sessions, preview-reload pub/sub. Isolated Redis is an empty site unless you copy `dump.rdb`, and then it drifts from live folders. |
| **data/** | **Share** | `data/blogs`, `data/static`, `data/ssl`. Same fixture sites the operator already uses. `fork.sh` already assumes this. |
| **airlock** | **Share** | One Chromium. Bookmark screenshots / remote images still work if the sidecar gets the same `BLOT_AIRLOCK_*` URLs. |
| **toxiproxy** | **Skip** | Sidecars talk to `redis` directly, same as `scripts/cursor/up.sh`. |
| **Scheduler / client watchers / SITE template build** | **Main only** | Two masters on shared Redis would double-run cron, contend for sync locks, and overwrite templates. Sidecar `CONTAINER_NAME` must not be `blot-container-green`. |

### What sharing implies (be honest)

- Dashboard POSTs, template-editor saves, and folder writes from a worktree
  host mutate the **shared** Redis and `data/`. Fine for clicking around;
  dangerous if the branch wipes keys. Treat worktree URLs as the same
  database with different code.
- Folder sync and SITE-template rebuilds still run in the **main** Node
  process. A worktree that only changes `app/sync` or `app/templates/source`
  will not exercise that new code until you isolate (v2) or check the branch
  out.
- Dashboard/docs/CSS/JS **do** come from the worktree: `documentation({ watch:
  true })` writes `app/views-built` in that tree; Express serves it.
- Blog HTML uses worktree render code + shared Redis templates/entries.
  Rendering, middleware, and dashboard changes are the cases this is for.
- Each Node process has its own Redis client-side cache and in-process LRUs.
  Stale reads vs main are possible for a few seconds; acceptable locally.

### v2 (only if v1 is not enough)

`--isolated`: sidecar Redis (no host port) seeded from a copy of
`data/redis/dump.rdb`, optional copy of `data/blogs`, sidecar is master of
that Redis. Use for schema/sync/template-build work. Do not build this until
v1 is in daily use.

## URL scheme

Reserve the label `wt` under `local.blot`:

| | Main stack | Worktree `my-feature` |
|---|---|---|
| Dashboard | `https://local.blot` | `https://my-feature.wt.local.blot` |
| Blog | `https://example.local.blot` | `https://example.my-feature.wt.local.blot` |
| CDN | `https://cdn.local.blot` | `https://cdn.my-feature.wt.local.blot` |
| Preview | `https://preview-of-blog-on-example.local.blot` | `https://preview-of-blog-on-example.my-feature.wt.local.blot` |

`BLOT_HOST=my-feature.wt.local.blot` on the sidecar.

Why not `{branch}.local.blot` or `{handle}.{branch}.local.blot`?

- `preview-of-…` already occupies hyphenated names under `local.blot`.
- `www.{handle}.local.blot` is a real blog host (`app/blog/lib/blogHosts.js`).
- Label count is therefore not a reliable router.
- `*.wt.local.blot` cannot collide with a blog handle (`wt` will be banned).

Slug: lowercase DNS label from the branch (`cursor/foo-bar-dab5` →
`foo-bar-dab5`), `[a-z0-9-]`, max 63 characters. On collision, append the
worktree directory basename.

## TLS and DNS

dnsmasq: no change (`address=/blot/127.0.0.1` already covers this).

mkcert: extend `config/openresty/setup.sh` so the cert SANs are:

```
local.blot
*.local.blot
*.wt.local.blot
*.*.wt.local.blot
```

Browsers accept nested wildcards as explicit SANs (this is not a public CA).
`setup.sh` today returns early if `data/ssl` already has files — it must
inspect SANs (`openssl x509 -noout -ext subjectAltName`) and regenerate when
the `wt` names are missing, otherwise existing local certs stay too narrow
and Chrome will warn on worktree blog hosts.

`www.example.my-feature.wt.local.blot` would need a third nested wildcard;
ignore it until someone cares.

## Compose layout

Keep the main file as the one-and-only owner of redis, nginx, airlock,
toxiproxy, and published ports.

Add `scripts/development/docker-compose.worktree.yml`:

- **Project name** `blot-wt-<slug>` — never `blot`.
- **Network** `blot_default` `external: true` (joins the running main stack).
- **Service** one `node-app`:
  - `image: blot` (do not rebuild unless `package.json` / Dockerfile changed)
  - `container_name: blot-node-wt-<slug>` (stable DNS name for nginx)
  - **no `ports:`**
  - `mem_limit` ~512–768m, `cpus` ~0.25, smaller `--max-old-space-size`
    (main is 1365m / 0.75 CPU — do not multiply that per agent)
  - `CONTAINER_NAME=blot-container-wt-<slug>` (not master)
  - `BLOT_HOST=<slug>.wt.local.blot`
  - `BLOT_REDIS_HOST=redis`
  - `BLOT_AIRLOCK_*` same as main
  - `BLOT_DIRECTORY=/usr/src/app` so `config` resolves inside the container
  - volumes: worktree `app`, `config`, `scripts`, `tests`, `notes`, `TODO`;
    **main** `data/` and `.env` via `git rev-parse --git-common-dir`
  - same nodemon command as main
- Do not start redis, nginx, toxiproxy, or airlock in this file.

Main `compose down --remove-orphans` will not reap these (different project).
`start.sh` cleanup must also `docker compose -p blot-wt-<slug> down` for each
known sidecar, or the sidecars sit on a dead Redis.

## Nginx routing

`config/openresty/development_server.conf` today has one `default_server` that
sends every host to `node-app`. Add a regex server **without**
`default_server`:

```nginx
# Docker embedded DNS. Required because the upstream hostname is a variable.
resolver 127.0.0.11 valid=10s ipv6=off;

server {
    listen 443 ssl;
    server_name ~^(?:.+\.)?(?<wt_slug>[a-z0-9-]+)\.wt\.local\.blot$;

    ssl_certificate     /etc/ssl/certs/wildcard.crt;
    ssl_certificate_key /etc/ssl/private/wildcard.key;

    location / {
        set $wt_upstream http://blot-node-wt-$wt_slug:8080;
        proxy_pass $wt_upstream;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Request-ID $request_id;
        # same body size / cache-control as the main server
    }
}
```

Missing container → Docker DNS fail → 502 (existing `502.html`). No nginx
reload per worktree if container names stay `blot-node-wt-<slug>`.

nginx wildcard `server_name` only allows a leftmost `*`, so
`*.*.wt.local.blot` is not valid — regex is required.

HTTP :80 can keep the existing catch-all 301 to HTTPS; that already preserves
`$host`.

## Node process: skip more than "not master"

`config.master` already skips scheduler, client `init()`, and SITE template
build. Also for sidecars:

- Do not send `email.SERVER_START` (`app/index.js`) — Mailgun would fire on
  every agent boot if `.env` has keys.
- Keep `configureLocalBlogs()` — it is idempotent and prints the worktree
  login URL.
- Keep `documentation({ watch: true })` so brochure/dashboard asset changes
  rebuild in that worktree. Optional later: `BLOT_SKIP_DOCS_WATCH` if CPU
  adds up.
- Do not run `templates({ watch: true })` (already master-only). Template
  **source** changes in a worktree stay invisible on the sidecar until v2 or
  a main-tree checkout. Document that in AGENTS.md.

## Lifecycle

Scripts (names indicative):

- `scripts/development/worktree-slug.sh` — branch → DNS label
- `scripts/development/worktree-up.sh` — start/replace one sidecar; print
  dashboard + blog URLs + `docker exec blot-node-wt-<slug> node scripts/blog/access.js …`
- `scripts/development/worktree-down.sh`
- `scripts/development/worktree-sync.sh` — `git worktree list --porcelain`,
  skip the main tree (`git-dir` == `git-common-dir`), up each linked
  worktree, down sidecars whose worktree is gone

`npm start` (`scripts/development/start.sh`) should run `worktree-sync` in
the background on an interval (or inotify on `.git/worktrees`) so **the
operator does not have to remember**. Agent-created worktrees appear as
subdomains within a minute.

Package scripts: `worktree:up`, `worktree:down`, `worktree:sync`.

Detect "I am in a worktree" with:

```
git rev-parse --git-dir
git rev-parse --git-common-dir
```

If they differ, `worktree-up.sh` can no-op-succeed when called from the
agent, using the current tree.

Do not auto-start sidecars from `scripts/cursor/start.sh` (Cloud Agent VM
already *is* the only checkout).

## Agent workflow after this

Today, `app/views/AGENTS.md` and `app/templates/AGENTS.md` say: if
`https://local.blot` is down, stop; never substitute another URL; exec into
`blot-node-app-1`.

After v1:

1. Operator keeps `npm start` in the main checkout.
2. Agent works in its worktree as now. No duplicate branch.
3. Sidecar comes up (sync watcher or `npm run worktree:up`).
4. Agent verifies at `https://<slug>.wt.local.blot` and
   `https://<handle>.<slug>.wt.local.blot`, and execs
   `blot-node-wt-<slug>` for `scripts/blog/access.js` / `scripts/info`.
5. `https://local.blot` remains the main checkout.

If the sidecar is missing, ask the operator to confirm `npm start` is
running — same as today — not to check out the branch.

## What this does not solve

- **Cloud Agent VMs.** Each already has its own stack. Viewing those from the
  operator's laptop needs a tunnel; out of scope.
- **Worktree changes to sync, SITE templates, scheduler, or Redis schema.**
  v1 will not run that code. Isolated mode (v2) or a main-tree checkout.
- **`package.json` / native-module changes.** Sidecars reuse the `blot`
  image's `node_modules`. Rebuild the image if sharp/re2/etc. change.
- **Many concurrent agents.** RAM is the limit (hundreds of MB per sidecar
  plus one Chromium). Sync should cap or LRU-stop old worktrees.

## Implementation sequence

1. **Certs** — extra mkcert SANs + regenerate-if-missing-SAN in `setup.sh`.
2. **Ban `wt`** as a blog handle (`app/models/blog/validate/banned.txt`).
3. **nginx** — regex server + Docker resolver in
   `development_server.conf`.
4. **Compose overlay** — `docker-compose.worktree.yml` as specified.
5. **Scripts** — slug / up / down / sync; hook sync into `start.sh`;
   tear down sidecars on Ctrl-C.
6. **Quiet sidecar boot** — skip `SERVER_START` email when not master
   (or when `CONTAINER_NAME` contains `wt`).
7. **npm scripts** and a short section on the run-locally developer guide.
8. **AGENTS.md** (views + templates) — worktree URLs and container names.
9. **Manual check** — main `https://local.blot` unchanged; worktree
   dashboard login; `https://example.<slug>.wt.local.blot` renders; nodemon
   restart on a worktree edit; 502 when the sidecar is down; `compose down`
   of main does not leak sidecars.

No production deploy step. Local Docker + a one-time cert regen on machines
that already have `data/ssl`.

## Alternatives considered

- **Full compose clone per worktree** (own Redis, nginx, ports). Port
  collision, N copies of Chromium, empty `data/`, operator has to remember
  port numbers. Worse DX than subdomains.
- **`BLOT_HOST=<slug>.local.blot` without a `wt` infix.** Collides with
  `preview-of-*` and is ambiguous to nginx vs main blogs.
- **Path-based** (`local.blot/__wt/<slug>/…`). Express `vhost(config.host,
  site)` and blog hosts assume a hostname, not a prefix. Large app change.
- **Bind-mount the worktree `app/` over the main container.** Only one
  worktree at a time; nodemon storms; same problem as checking the branch
  out.
- **Separate Redis DB number (`SELECT n`).** The client has no DB config
  today; you'd still need to copy keys; pub/sub and client-side cache make
  it easy to get wrong. A cloned `dump.rdb` (v2) is clearer.
- **OpenResty Lua / Traefik labels.** Disproportionate for a few local
  sidecars. Stock nginx regex is enough.
