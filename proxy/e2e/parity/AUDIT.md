# Request audit: what reaches the disk cache, and how it differs from master

Read from the generated config (`proxy/build/data/latest/openresty.conf`, rendered
from `proxy/config`) on this branch and on origin/master, and from the app's routes
(`app/server.js`, `app/site`, `app/blog`, `app/clients`, `app/cdn`).

The two configs differ only in the three `location /` blocks that were cached (blog
hosts, custom domains, the site), the `/error-upstream-offline.html` locations (the
branch releases the fill lock there), the Lua set-up in `init.conf`/`http.conf`, and
the internal `/purge` server (`/inspect` and `/rehydrate` are gone). Every other
`location` and `server` block renders byte for byte the same (`diff` of the two
files; run it again after touching `proxy/config`). So the rows below marked
"not cached" are untouched by construction; the parity test sends them anyway.

Hosts: **blog** = `*.blot.im` (not `preview-`), **custom** = any other Host (the
default server, same `blot-blogs.conf` plus `auto-ssl.conf`), **site** = `blot.im`,
**preview** = `preview-*.blot.im`, **cdn**, **webhooks**.

Cache = `location /` of `blot-blogs.conf` or `blot-site.conf`: master `proxy_cache`
(+ `cacher.lua` index), branch `diskcache.lua` (`access` serves a hit, `@diskcache_fill`
fetches and stores a miss). `limit_except GET HEAD` (403 for other methods) and
the rate limits are in both.

Tests: **DC** = `diskcache-checks.js`, **CH** = `checks.sh`, **P:group** = a group of
`parity-checks.js` (master and branch compared).

## Blog hosts (blog and custom)

| Request | Methods | Location (master = branch) | Cached | Tests | Notes |
|---|---|---|---|---|---|
| Entries, home, `/page/N`, `/tagged/x`, archive, pages, template views | GET HEAD | `/` | yes (200 1y) | DC basic, P:blog | HEAD: branch never fills (see differences) |
| `/search?q=` | GET | `/` | yes, one entry per query | P:blog, P:url | **Flag, same on master**: `/search` takes arbitrary queries, so the cache grows with them (Node sends no Cache-Control) |
| `feed.rss`, `feed.json`, `sitemap.xml`, `robots.txt` (also preview/custom variant), `*.css`, `*.js`, JSON, SVG | GET HEAD | `/` | yes | P:blog, P:accept-encoding | br/gzip negotiated per request |
| Images, thumbnails (`/_image_cache`), `/_assets/*`, folder files, fonts, PDFs, audio/video | GET HEAD, **Range** | `/` | yes, whole body | P:blog, P:range, P:first-request, P:large | Node answers Range itself for folder files (Accept-Ranges); the proxy always stores the whole file. **Difference**: Range on a first request, see bugs |
| Folder files over 256 KB of a CDN-safe type | GET HEAD | `/` | the 302 to `cdn.` is cached 1y | P:status (302) | Node sends `Cache-Control: no-cache` with it; ignored by both |
| Blog redirects (301 from the blog's own redirect list, 302) | GET HEAD | `/` | yes (301 302) | DC redirects, P:status | |
| 404 pages (`store404` side effect on Node) | GET HEAD | `/` | yes (400 404) | DC, P:status | |
| 403, 410, 429, 500, 503 from Node | GET | `/` | no (not in `proxy_cache_valid` / `CACHEABLE`) | P:status | 500, 502, 504, 429 are replaced by the offline page (`proxy_intercept_errors`); **503 passes through** (Redis outage page, `Retry-After`) |
| Node down (connection refused) | any | `/` then `error_page 502` | no | P:pass 5, DC upstream errors | offline page, 502 |
| `/random` | GET | `= /random` (`reverse-proxy.conf`) | no | P:blog-uncached | 302 with `no-cache` |
| `/draft/stream/*` (SSE, 24 h) | GET | `/draft/stream/` (`reverse-proxy-sse.conf`) | no, unbuffered | P:sse | |
| `/draft/view/*` (draft preview HTML) | GET | `/` | yes | P:blog | **Flag, same on master**: Node sends `Cache-Control: no-cache` and removes frame protection; both ignore it. A draft edit purges the host, so it is not stale |
| `/verify/domain-setup`, `/verify/subscription-duration` | GET | `/` | yes | P:blog | **Flag, same on master**: `Cache-Control: no-cache` is ignored, so the dashboard's domain check and the subscription duration are answered from the cache until the next purge |
| `/__blot/preview/reload` (SSE) | GET | `/` (blog host) | the 404 the app answers off a preview host | P:sse | the real stream is on the preview host |
| Any other method (POST, PUT, DELETE, PATCH, OPTIONS, WebDAV) | all | `/` | no: `limit_except` answers 403 | DC POST, P:methods | the blog has no write routes |
| `/health` | GET | `= /health` (200 from nginx) | no | CH | |
| Scanner paths (`.env`, `wp-admin`, `*.php`, `.git`, ...) | any | 40 `location` blocks, 444 / 403 | no | CH hardening, P:blog-uncached | |
| `/files/signal.pdf`, the `_assets` .wav | GET | exact `location`, 301 to `cdn.` | no | P:blog-uncached | |
| `/error-upstream-offline.html` | GET | `= /error-upstream-offline.html` | no | P:blog-uncached | branch also releases a held fill lock here |
| `/.well-known/acme-challenge/*` | GET | custom: `auto-ssl.conf` (Lua); blog subdomain: `/` | custom no; blog yes (a 404) | P:blog-uncached | |
| Host spellings (`PARITY.x`, `x:80`, `x.`, bare IP) | GET | `/` | one key per `$host` | P:host | |
| URL forms (encoded, non-ASCII bytes, `//`, 9000-byte path, 40 KB query) | GET | `/` | one entry per `$request_uri` | P:url | |

## Site (`blot.im`)

| Request | Methods | Location | Cached | Tests | Notes |
|---|---|---|---|---|---|
| Home, `/how/*`, `/templates*`, `/news`, `/about`, `/contact`, `/questions` list, `/questions/tags` ..., `sitemap.xml`, `robots.txt`, css/js/images/favicons | GET HEAD | `/` | yes | DC basic (https), P:site (HTTP/1.1 and HTTP/2) | |
| `/questions/replies`, `/tags`, `/search?query=`, `/feed.rss`, tagged | GET | `/` | yes | P:site, P:node-headers | **Flag, same on master**: `Questions.use(["/ask", "/:id"], session, csrf)` matches every `/questions/<word>`, so these set `__Host-csrf` on first visit and are cached. Master replayed the filler's cookie to every later visitor (one shared csrf token); the branch does not replay Set-Cookie. `/questions/search` also sends `Cache-Control: private`, ignored: one entry per query |
| `/questions/<n>`, `/questions/ask`, `/news/sign-up`, `/news/cancel`, `/questions/<id>/edit`, `/new` | GET POST | exact / regex `location`s (`reverse-proxy.conf`) | no (csrf) | P:site-uncached | |
| `/sites`, `/sites/<handle>*` (dashboard, per-user, sessions) | all | `/sites`, regex (`reverse-proxy-huge.conf`, 1000 MB, writes to green) | no | P:site-uncached, P:webhook | |
| `/sites/log-in`, `sign-up`, `account/password` | all | regex (4 KB body) | no | P:site-uncached | |
| `/sites/<h>/import*`, `/sites/<h>/client/dropbox/authenticate` | all | regex, pinned to `blot_node` | no | P:site-uncached | |
| `/sites/<h>/status` (SSE) | GET | regex (`reverse-proxy-sse.conf`) | no, unbuffered | P:sse (h1, h2) | |
| `/clients/*` (Dropbox, Google Drive webhooks and OAuth, iCloud macserver uploads, git smart HTTP) | all | `/clients`, `/clients/git/end/` (2000 MB) | no | P:webhook, P:site-uncached | |
| `/stripe-webhook`, `/paypal-webhook`, `/redis-health` | all | exact `location`s | no | P:webhook, P:site-uncached | |
| `/dashboard*` | all | `/dashboard` | no | P:site-uncached | |
| `/cdn/*` | GET | regex, 301 to `cdn.blot.im` | no | P:site-uncached | |
| `/health` | GET | `= /health` | no | CH | |

## Other hosts

| Request | Location | Cached | Tests | Notes |
|---|---|---|---|---|
| `preview-*`: template editor preview of a blog, including `/__blot/preview/reload` SSE | `/` of the preview server (`reverse-proxy-preview.conf`, 5x limits) | no | P:preview (http, https) | SSE here relies on Node's `X-Accel-Buffering: no`; same on master |
| `cdn.`: app static files from disk, everything else (folder files, `/blog_*`, generated assets) to Node | `/` try_files, `@cdn_node` (`reverse-proxy.conf`) | no (Bunny caches) | CH, P:cdn | Range and conditional headers go through to Node |
| `webhooks.`: relay `/connect` SSE and webhook POSTs | `/` (no cache, 24 h) | no | none (needs the auto-ssl certificate) | config renders identically on both |
| `127.0.0.1:80` / `:8077`: `/purge` | purge server | n/a | DC purge | `/inspect` and `/rehydrate` removed on the branch; `proxy/deploy/blue-green.sh` waits for "rehydrate: complete" on master |
| Unix socket health | `= /health` | no | DC | |
| `blot.im` on port 80 | 301 to https | no | CH | |

## What goes through the cache and arguably should not (all the same on master)

1. `/questions/<word>` pages set a csrf cookie (master replayed it to everyone).
2. `/search` and `/questions/search` store one entry per query string.
3. `/draft/view/*`, `/verify/*` and anything else Node marks `no-cache` or `private`
   are stored: both proxies ignore Cache-Control, Expires, Vary and Set-Cookie on
   purpose (tested: DC "headers Node sends").
4. A response with `X-Accel-Buffering: no` (Node's SSE helper) is **not** stored by
   master and **is** by the branch if it ends. No such route is behind the cache today.

# Differences found by the parity run

`proxy/e2e/parity-checks.js` sends the same 768 requests to the master image and to
this branch, through miss, hit, hit (brotli copies exist), purge + refill, Node
stopped and Node back. Each accepted difference is a rule with a reason in `INTENDED`
there (class *intended* = the design, *harmless* = not designed but not observable
in practice). What is left fails the run:

| # | Difference | Class | Evidence | Fix |
|---|---|---|---|---|
| 1 | A `Range` request for an entry that is not cached yet, to a Node answer that carries `Accept-Ranges` (folder files, video): master answers 206 (or 416), the branch 200 with the whole body. Later requests (hits) are 206 on both. nginx without `proxy_cache` passes Node's `Accept-Ranges` on and leaves the ranging to Node, but `@diskcache_fill` blanks `Range` so Node cannot | bug (medium: Safari expects 206 for `<video>`; the first play after every purge of the host is affected) | group `first-request`, `/p/ranged.bin?first=N`: `bytes=0-99` 206 vs 200, `bytes=99999999-` 416 vs 200 | `proxy_force_ranges on;` in `@diskcache_fill` makes the first answer a 206, **but** the range filter then cuts the body before `body_filter`, so the fill is judged truncated and not stored, and every miss gains `Accept-Ranges`. Tried, not enough. Needs a design choice: fill whole, then range from the stored file |
| 2 | A header Node sends twice (two `Link`) comes back once, the last value, on a hit | bug (small) | `/p/dup`: miss `Link` x2, hit x1; `X-Dup` the same | `send_headers` (`diskcache.lua`) assigns `ngx.header[name]` per pair. Group the values by name and assign a table: tried, the group matches |
| 3 | A 200 with no `Content-Type` gets `text/plain; charset=utf-8` on a hit (the static module's `default_type`; `nosniff` is on) | bug (small; Blot always sets a type on its pages) | `/p/no-content-type`: miss none, hit `text/plain` | serve such a hit through the Lua path the non-200 hits use, which strips it |

Accepted differences, by rule (counts from one run): `accept-ranges-on-hit`,
`last-modified-fill-time`, `vary-dropped-on-hit`, `weak-etag-on-hit`, `range-on-hit`
(a hit honours Range on every page, the baseline only for Node answers with
Accept-Ranges), `set-cookie-not-replayed`, `head-does-not-fill`, `head-forwarded`,
`head-hit-content-length`, `head-error-vary`, `if-none-match-before-if-modified-since`,
`preconditions-on-hit`, `conditional-on-miss`, `if-modified-since-only`,
`precondition-failed-headers`, `empty-body-not-compressed`, `stream-cached`.
