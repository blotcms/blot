# Request audit: what reaches the cached locations

Read from the generated config (`proxy/build/data/latest/openresty.conf`, rendered
from `proxy/config`) and from the app's routes (`app/server.js`, `app/site`,
`app/blog`, `app/clients`, `app/cdn`). Re-read it when `proxy/config` changes.

Hosts: **blog** = `*.blot.im` (not `preview-`), **custom** = any other Host (the
default server, same `blot-blogs.conf` plus `auto-ssl.conf`), **site** = `blot.im`,
**preview** = `preview-*.blot.im`, **cdn**, **webhooks**.

Cache = `location /` of `blot-blogs.conf` or `blot-site.conf` (both include
`reverse-proxy-cache.conf`): nginx `proxy_cache` keyed on
`$scheme://$host$request_uri`, with `cacher.lua` keeping a per-host index for
`/purge`. `limit_except GET HEAD` (403 for other methods) and the rate limits
apply there.

Tests: **RM** = `request-matrix.js` (section number), **CH** = `checks.sh`,
**P:group** = a group of `parity-checks.js` (origin/master against the working tree).

## Blog hosts (blog and custom)

| Request | Methods | Location | Cached | Tests | Notes |
|---|---|---|---|---|---|
| Entries, home, `/page/N`, `/tagged/x`, archive, pages, template views | GET HEAD | `/` | yes (200 1y) | RM 1, P:blog | HEAD fills the entry |
| `/search?q=` | GET | `/` | yes, one entry per query | P:blog, P:url | **Flag**: `/search` takes arbitrary queries, so the cache grows with them (Node sends no Cache-Control) |
| `feed.rss`, `feed.json`, `sitemap.xml`, `robots.txt` (also preview/custom variant), `*.css`, `*.js`, JSON, SVG | GET HEAD | `/` | yes | P:blog, P:accept-encoding | br/gzip negotiated per request |
| Images, thumbnails (`/_image_cache`), `/_assets/*`, folder files, fonts, PDFs, audio/video | GET HEAD, **Range** | `/` | yes, whole body | P:blog, P:range, P:first-request, P:large | Node answers Range itself for folder files (Accept-Ranges); the proxy always stores the whole file. A first Range request gets the whole body unless Node sends Accept-Ranges (RM 8, KNOWN) |
| Folder files over 256 KB of a CDN-safe type | GET HEAD | `/` | the 302 to `cdn.` is cached 1y | P:status (302) | Node sends `Cache-Control: no-cache` with it; ignored by both |
| Blog redirects (301 from the blog's own redirect list, 302) | GET HEAD | `/` | yes (301 302) | RM redirects, P:status | |
| 404 pages (`store404` side effect on Node) | GET HEAD | `/` | yes (400 404) | DC, P:status | |
| 403, 410, 429, 500, 503 from Node | GET | `/` | no (not in `proxy_cache_valid` / `CACHEABLE`) | P:status | 500, 502, 504, 429 are replaced by the offline page (`proxy_intercept_errors`); **503 passes through** (Redis outage page, `Retry-After`) |
| Node down (connection refused) | any | `/` then `error_page 502` | no | P:pass 5, RM upstream errors | offline page, 502 |
| `/random` | GET | `= /random` (`reverse-proxy.conf`) | no | P:blog-uncached | 302 with `no-cache` |
| `/draft/stream/*` (SSE, 24 h) | GET | `/draft/stream/` (`reverse-proxy-sse.conf`) | no, unbuffered | P:sse | |
| `/draft/view/*` (draft preview HTML) | GET | `/` | yes | P:blog | **Flag**: Node sends `Cache-Control: no-cache` and removes frame protection; both ignore it. A draft edit purges the host, so it is not stale |
| `/verify/domain-setup`, `/verify/subscription-duration` | GET | `/` | yes | P:blog | **Flag**: `Cache-Control: no-cache` is ignored, so the dashboard's domain check and the subscription duration are answered from the cache until the next purge |
| `/__blot/preview/reload` (SSE) | GET | `/` (blog host) | the 404 the app answers off a preview host | P:sse | the real stream is on the preview host |
| Any other method (POST, PUT, DELETE, PATCH, OPTIONS, WebDAV) | all | `/` | no: `limit_except` answers 403 | RM POST, P:methods | the blog has no write routes |
| `/health` | GET | `= /health` (200 from nginx) | no | CH | |
| Scanner paths (`.env`, `wp-admin`, `*.php`, `.git`, ...) | any | 40 `location` blocks, 444 / 403 | no | CH hardening, P:blog-uncached | |
| `/files/signal.pdf`, the `_assets` .wav | GET | exact `location`, 301 to `cdn.` | no | P:blog-uncached | |
| `/error-upstream-offline.html` | GET | `= /error-upstream-offline.html` | no | P:blog-uncached |  |
| `/.well-known/acme-challenge/*` | GET | custom: `auto-ssl.conf` (Lua); blog subdomain: `/` | custom no; blog yes (a 404) | P:blog-uncached | |
| Host spellings (`PARITY.x`, `x:80`, `x.`, bare IP) | GET | `/` | one key per `$host` | P:host | |
| URL forms (encoded, non-ASCII bytes, `//`, 9000-byte path, 40 KB query) | GET | `/` | one entry per `$request_uri` | P:url | |

## Site (`blot.im`)

| Request | Methods | Location | Cached | Tests | Notes |
|---|---|---|---|---|---|
| Home, `/how/*`, `/templates*`, `/news`, `/about`, `/contact`, `/questions` list, `/questions/tags` ..., `sitemap.xml`, `robots.txt`, css/js/images/favicons | GET HEAD | `/` | yes | RM 1 (https), P:site (HTTP/1.1 and HTTP/2) | |
| `/questions/replies`, `/tags`, `/search?query=`, `/feed.rss`, tagged | GET | `/` | yes | P:site, P:node-headers | **Flag**: `Questions.use(["/ask", "/:id"], session, csrf)` matches every `/questions/<word>`, so these set `__Host-csrf` on first visit and are cached. The cached Set-Cookie is replayed to every later visitor (one shared csrf token). `/questions/search` also sends `Cache-Control: private`, ignored: one entry per query |
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
| `preview-*`: template editor preview of a blog, including `/__blot/preview/reload` SSE | `/` of the preview server (`reverse-proxy-preview.conf`, 5x limits) | no | P:preview (http, https) | SSE here relies on Node's `X-Accel-Buffering: no`;  |
| `cdn.`: app static files from disk, everything else (folder files, `/blog_*`, generated assets) to Node | `/` try_files, `@cdn_node` (`reverse-proxy.conf`) | no (Bunny caches) | CH, P:cdn | Range and conditional headers go through to Node |
| `webhooks.`: relay `/connect` SSE and webhook POSTs | `/` (no cache, 24 h) | no | none (needs the auto-ssl certificate) | |
| `127.0.0.1:80` / `:8077`: `/purge` | purge server | n/a | RM purge | `/inspect` and `/rehydrate` exist; `proxy/deploy/blue-green.sh` waits for "rehydrate: complete" |
| Unix socket health | `= /health` | no | RM | |
| `blot.im` on port 80 | 301 to https | no | CH | |

## What goes through the cache and arguably should not

1. `/questions/<word>` pages set a csrf cookie (the cached Set-Cookie is replayed to everyone).
2. `/search` and `/questions/search` store one entry per query string.
3. `/draft/view/*`, `/verify/*` and anything else Node marks `no-cache` or `private`
   are stored: the proxy ignores Cache-Control, Expires, Vary and Set-Cookie on
   purpose (tested: RM 10).
4. A response with `X-Accel-Buffering: no` (Node's SSE helper) is **not** stored.
   No such route is behind the cache today.

# The disk cache against the old cache

`proxy/e2e/parity-checks.js` sends the same requests to the origin/master image
(nginx `proxy_cache` + `cacher.lua`) and to this tree (`diskcache.lua`), through
miss, hit, hit (brotli copies exist), purge + refill, Node stopped and Node back.
Each accepted difference is a rule with a reason in `INTENDED` there (class
*intended* = the design, *harmless* = not designed but not observable in
practice): `range-on-hit`, `preconditions-on-hit`, `head-does-not-fill`,
`head-forwarded`, `head-hit-content-length`, `head-error-vary`,
`precondition-failed-headers`, `unsatisfiable-range-stored`,
`set-cookie-not-replayed`, `vary-dropped-on-hit`, `accept-ranges-on-range-miss`,
`accept-ranges-on-hit`, `empty-body-not-compressed`. Anything else fails the run.
