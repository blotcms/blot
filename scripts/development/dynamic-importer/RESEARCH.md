# `npm run dynamic-importer <url>` — Research

Research notes for a **content acquisition** script: point it at a live website,
and get back a folder of Blot-compatible Markdown and image files.

It is the companion to `scripts/development/translate`, which builds a *template*
against a folder of content. The two are deliberately separate tools:
this one produces content, that one produces a design. The operator moves the
output of this script into a site folder scaffolded by that one.

**Scope**

- **In scope:** crawling a live site and converting its pages into Blot content,
  using an AI agent (the Claude Code CLI) for extraction and editorial judgement.
- **Out of scope: platform exports.** WordPress, Squarespace, Blogger and Are.na
  already have working importers in Blot's dashboard. If the source site is one of
  those, the operator uses the dashboard importer and downloads the resulting ZIP —
  no new code needed. This script is for sites with **no export available**, which
  is exactly why the agent is worth the cost.
- **Out of scope: the dashboard.** This is an operator-run script and will stay
  one. An agent-driven importer running server-side, per user, against untrusted
  third-party HTML, with cost attached, is a different and much larger problem.
- **Out of scope: templates.** The output is content only. It renders against
  Blot's default `SITE:blog` template purely so the import can be checked.

**It provisions its own scratch Blot site** so the imported content can actually be
rendered and inspected — the agent needs to see whether Markdown converted
correctly, images resolved and dates parsed, not merely whether files appeared on
disk. That scratch site is throwaway; the deliverable is the folder.

Everything below was verified against the code in this repository. File paths are
repo-relative. Where the shipped documentation disagrees with the code, the code
behaviour is stated and the discrepancy flagged.

---

## 0. Shape of the tool

```
npm run dynamic-importer <url>

  A. Preflight     server must already be running (§1.5)
  B. Provision     scratch blog on the local dev account, client "local" (§2)
  C. Crawl         discover + fetch + clean → JSON records            (§5)
  D. Extract       agent turns records into `post` objects            (§5)
  E. Build         post objects → shared import waterfall → files     (§4)
  F. Verify        render in the scratch site; agent checks fidelity  (§6.4)
  G. Hand off      operator copies the content into a translate site
```

The single most important design fact: **step E reuses Blot's existing import
waterfall** (`app/dashboard/site/import/helper/`), the same one the WordPress,
Blogger and Are.na importers use. Only steps C and D are new. That keeps path
allocation, image downloading, Markdown conversion and metadata emission identical
to every other importer in the codebase.

---

## 1. Development environment

### 1.1 Stack layout

`scripts/development/start.sh` boots `scripts/development/docker-compose.yml`:

- `node-app` — image `blot`, Dockerfile target `dev`, runs
  `nodemon /usr/src/app/app/index.js`. Container name is `blot-node-app-1`.
- `redis` — 6.2.12-alpine, port 6379 exposed to the host.
- `toxiproxy` — injects Redis latency once the app reports readiness (disabled
  during startup and during nodemon restarts). `BLOT_USE_TOXIPROXY=false` opts out.
- `nginx` (openresty) — ports 80/443, terminates TLS for `local.blot`.

`start.sh` also runs `node scripts/development/open-folder-server.js` **on the host**
(port 3020) so the dashboard's "open folder" button can `open -R` a real Finder path.

### 1.2 Host ↔ container path mapping (critical)

From the compose file, `../../data:/usr/src/app/data` — so:

```
host:      /Volumes/Blot/blot/data/blogs/<blogID>/
container: /usr/src/app/data/blogs/<blogID>/
```

`config/index.js` sets `blog_folder_dir = BLOT_DATA_DIRECTORY + "/blogs"` and
`helper/localPath(blogID, path)` resolves to `<blog_folder_dir>/<blogID>/<path>`.

**Consequence:** the Claude Code CLI can run on the host, in
`data/blogs/<blogID>/`, and its edits are seen by the container. The
`app/clients/local` chokidar watcher will pick them up and rebuild.

**This was flagged as a risk and has now been tested empirically — it works.**
Procedure and results, run against this machine's stack:

1. Set a scratch blog to `client: "local"` and started the watcher in the master
   process by publishing to `clients:local:new-folder` (§2.4).
2. Wrote `watcher-test.txt` at the folder root **from the host**. The container
   synced it **within the same second**:
   `sync_4008d0a client=local /watcher-test.txt Saving file in database succeeded`,
   followed by `Building templates from folder` and `Updating cacheID of blog`.
3. Wrote a nested `2026/01-15-nested.txt`. Also picked up; `Entries.getAllIDs`
   returned both paths.
4. Deleted both from the host. Both were dropped:
   `/2026/01-15-nested.txt Dropping from database succeeded`.

So Docker Desktop's bind mount propagates inotify events for creates, nested
creates and deletes. **No `--rebuild` fallback is required for correctness.**

**Two caveats that do affect the design:**

- **Latency is variable.** Creates landed instantly, but the delete sync landed
  roughly half a minute after the `rm` — file events go onto a per-blog
  `async.queue`, each item takes a `proper-lockfile` lock on the folder, and syncs
  are serialised. A verification loop must therefore **wait for a settling signal
  before re-screenshotting**, not poll immediately. `blog.cacheID` is bumped at the
  end of every sync (`Updating cacheID of blog`), which makes it a usable
  "the rebuild finished" marker.
- **Deletes are soft.** `Entries.getAllIDs` still returns removed paths; the entry
  is marked `deleted: true` rather than dropped from the index (verified). Any
  check for "is this post gone" must read the flag, not the ID list.

### 1.3 Existing `npm run` script conventions

`package.json` scripts wrap either a bash file in `scripts/development/` or a
`docker exec`:

```json
"folder":  "./scripts/development/folder.sh",
"login":   "docker exec -it blot-node-app-1 /bin/sh",
"featured":"docker exec blot-node-app-1 node app/documentation/featured/build",
```

`scripts/development/folder.sh` is the closest structural precedent for the new
script: validate an argument, print usage when absent, then
`docker exec blot-node-app-1 npx nodemon app/templates/folders ... "$FOLDER_NAME"`.

Module resolution inside the container relies on `ENV NODE_PATH=/usr/src/app/app`
(Dockerfile), which is why app code does `require("models/blog")`,
`require("helper/localPath")`, `require("config")` etc. Any Node script that
touches models **must run inside the container** (or set `NODE_PATH` and have a
reachable Redis — Redis *is* exposed on host port 6379, so a host-side script is
possible but would need `BLOT_DATA_DIRECTORY` pointing at the repo `data/`).

Recommendation: keep model manipulation inside `docker exec`, and run the Claude
Code CLI on the host.

### 1.4 Config values that matter

`config/index.js`:

| Key | Dev value |
|---|---|
| `environment` | `development` (unless `NODE_ENV=production`) |
| `host` | `process.env.BLOT_HOST` — `start.sh` defaults it to `local.blot` |
| `protocol` | `https://` |
| `cdn.origin` | `https://cdn.local.blot` |
| `blog_folder_dir` | `<repo>/data/blogs` |
| `blog_static_files_dir` | `<repo>/data/static` |
| `tmp_directory` | `<repo>/data/tmp` |

Site URL is therefore `https://<handle>.local.blot`.

### 1.5 Preflight — the server must already be running

**The script does not start the stack.** It assumes `npm start` is running in
another window, and aborts with a clear message if it is not. Starting the stack
from inside `translate` would be wrong: `start.sh` is long-lived and interactive
(it tails logs, manages toxiproxy, and traps `INT`/`TERM` to save Redis and tear
down the compose project), so it cannot be composed into a one-shot script.

**Health endpoints** (both verified returning `200 OK` against the running stack):

| URL | Handler |
|---|---|
| `https://<config.host>/health` | `app/site/index.js:49` — the site vhost |
| `http://localhost:8080/health` | `app/server.js:116` — the Express catch-all, `Cache-Control: no-store` |

Check `https://<config.host>/health` rather than `localhost:8080`, because it
exercises the whole path the script actually depends on: nginx → TLS → vhost
routing → the `config.host` value the rest of the script will build URLs from.

**Local DNS and TLS on this machine** (verified):

- `/etc/resolver/blot` contains `nameserver 127.0.0.1`, so a local resolver maps
  `*.blot` — including wildcard subdomains such as `<handle>.local.blot` and
  `preview-of-x-on-y.local.blot` — to `127.0.0.1`. There is **no** `/etc/hosts`
  entry for `local.blot`; do not look for one.
- `scripts/development/proxy/setup.sh` generates a wildcard cert for `$BLOT_HOST` and
  `*.$BLOT_HOST` with `mkcert` into `data/ssl/`, and `mkcert -install` trusts it.
  It exits early if `data/ssl/certs/wildcard.crt` and `.../private/wildcard.key`
  already exist.

Because the cert is only trusted if `mkcert -install` has run on that machine, the
preflight should tolerate an untrusted cert (`curl --insecure`, or Node with
`rejectUnauthorized: false`) — a TLS trust failure is not the same as the server
being down, and shouldn't produce a misleading error.

**Suggested preflight sequence, each with its own remedy message:**

1. `docker ps` lists `blot-node-app-1` → else "the development stack is not
   running; run `npm start` in another window".
2. `GET https://<config.host>/health` returns `200` within a short timeout → else
   the same message (the container can be up while the app is still booting or
   mid-nodemon-restart, so a couple of retries with a short backoff is reasonable).
3. Optional: confirm the dev account and its blogs exist. They are created by
   `app/configure-local-blogs.js` at boot, so a successful (2) implies (3) — but
   an explicit check gives a better error than a downstream crash.

Note the `BLOT_HOST` resolution order the script must mirror: `start.sh` defaults
it to `local.blot` and passes it into compose, while `config/index.js` defaults to
`localhost` when the variable is absent. A script running on the **host** without
`BLOT_HOST` set would compute `localhost` and check the wrong URL. Read
`BLOT_HOST` from the environment with a `local.blot` default (matching
`start.sh`), or read the effective value out of the container:

```bash
docker exec blot-node-app-1 node -e 'console.log(require("config").host)'
```

The second form is authoritative and worth preferring.

---


## 2. Provisioning the scratch site

### 2.1 Where `example@example.com` comes from — investigated

**It is a hardcoded literal, not configuration.** `app/configure-local-blogs.js`
lines 6–7:

```js
const email = "example@example.com";
const password = "password";
```

There is no env var, no config key, and no `.env` entry behind it. It is not
`config.admin.email`, and it is not overridable without editing that file.
`grep -rn "example@example.com" app scripts config` returns only this file plus
documentation prose (`app/views/about/notes/_guides/_development-application-state.txt`,
which tells developers to run `node scripts/user/create example@example.com …`)
and a test fixture in `scripts/email/newsletter.js`.

`app/configure-local-blogs.js` runs at startup **in development only** — the
module exports `main` when `config.environment === "development"` and a no-op
otherwise. It:

- Ensures user `example@example.com` / password `password` exists
  (`User.getByEmail` → `User.hashPassword` → `User.create`).
- Creates a blog with handle `example` if the user has none.
- For every blog owned by that user: `Blog.set(blogID, { forceSSL: false, client })`
  where `client` falls back to `"local"` when unset.
- Prints the capability banner (`Local server capabilities: …`) plus a magic-link
  dashboard URL from `User.generateAccessToken`, the blog URL, and the folder path.

**The second account, for contrast.** `app/templates/folders/setupUser.js` uses:

```js
const FOLDER_ACCOUNT_EMAIL = config.admin.email || "folders@example.com";
```

`config.admin.email` is `process.env.BLOT_ADMIN_EMAIL` (`config/index.js:74`),
and **`BLOT_ADMIN_EMAIL` is not set in this repo's `.env`** — the file only
defines Stripe, PayPal, webhooks, session, Dropbox, Google Drive, iCloud and
Tumblr variables. So in practice that account is literally
`folders@example.com`, and it owns the demo folder blogs (`bjorn`, `clara`,
`david`, `documentation`, `hypertext`, `lecture`, `programmer`, `sergey`,
`thoughtforms`).

**Resolution:** attach translated sites to `example@example.com`. It is the
account `npm start` logs the developer into, it is the one whose blogs get
`client: "local"` and `forceSSL: false` applied automatically on every boot, and
keeping translated sites off `folders@example.com` avoids polluting the demo-folder
account that `app/templates/folders/index.js` manages and prints URLs for.

The script should still **look the user up rather than assume it exists**
(`User.getByEmail`, create if absent, mirroring `configure-local-blogs.js`) so it
works against a fresh Redis where the boot hook has not completed. If the email
ever needs to vary, the honest fix is to hoist the literal out of
`configure-local-blogs.js` into `config` — worth considering, but out of scope.

### 2.2 Blog creation API

`app/models/blog/create.js`:

```js
Blog.create(uid, { handle, title, timeZone, dateFormat, ... }, function (err, blog) { … })
```

- Generates `blogID` (`blog_<32 hex>` — see existing `data/blogs/` entries).
- Merges `app/models/blog/defaults.js`.
- Validates via `app/models/blog/validate/` before writing.
- `fs.emptyDir(localPath(blogID, "/"))` — creates the folder.

Relevant defaults (`app/models/blog/defaults.js`):

```js
client: "", template: "SITE:blog", timeZone: "UTC", dateFormat: "M/D/YYYY",
forceSSL: true, permalink: { format: "{{slug}}", custom: "", isCustom: false },
menu: [ Home /, Archives /archives, Search /search, Feed /feed.rss ],
plugins: build/plugins.defaultList, imageExif: "basic", cacheID: 0
```

### 2.3 Handle validation

`app/models/blog/validate/handle.js`:

- lowercased, trimmed
- `/^[a-zA-Z0-9]+$/` — **letters and digits only**, no hyphens or underscores
- 2–70 characters
- not in `app/models/blog/validate/banned.txt`
- not already taken (`err.code === "EEXISTS"`)

**Implication:** a handle derived from a URL must be aggressively sanitised.
`https://www.example.com/blog` → `examplecom` or `exampleblog`. Collisions need a
numeric suffix (still alnum-only, so `examplecom2` works).

### 2.4 Switching the blog to the local client

Two equivalent routes:

```js
Blog.set(blogID, { client: "local", forceSSL: false }, cb);
```

then run setup so the watcher starts:

```js
require("clients/local").setup(blogID, cb);   // exported for scripts/tests
```

**But that only helps inside the master process.** Calling `setup()` from a
`docker exec` starts a chokidar watcher in that short-lived process, which dies
when the process exits — verified. To make the *server* watch the folder you must
publish to the Redis channel the master process subscribes to:

```js
redisClient.publish(
  "clients:local:new-folder",
  JSON.stringify({ blogID })      // ← JSON object, NOT a bare blog ID
);
```

**The payload must be JSON.** `app/clients/local/init.js:46` does
`let { blogID } = JSON.parse(message)`. Publishing a bare ID throws
`SyntaxError: Unexpected token 'b' … is not valid JSON` in the server log and the
watcher never starts — verified by doing exactly that. Note
`app/clients/local/README` describes this only as "messages containing blog IDs",
which is what led to the mistake; the code is the contract.

`init.js` also re-initialises every `client === "local"` blog 5 s after boot, so a
server restart re-establishes all watchers regardless.

`app/clients/local/setup.js`:

- runs `sync/fix` on the blog
- **only in `config.environment === "development"`** starts a `chokidar` watcher on
  `localPath(blogID, "/")` with `ignoreInitial: true`
- every event is pushed into an `async.queue`; each item runs
  `Sync(blogID, (err, folder, done) => folder.update(path, …))`
- the watcher closes itself if `blog.client !== "local"`

`Sync` (`app/sync/index.js`) takes a `proper-lockfile` lock on the blog folder,
runs updates, then on release: checks renames, calls
`models/template.buildFromFolder(blogID)`, bumps `blog.cacheID`.

**That last point is important**: every sync also rebuilds templates from the
folder. So a content-file change and a template-file change both converge on the
same code path.

### 2.5 Reference implementations to copy

- `app/templates/folders/index.js` + `setupBlogs.js` + `setupUser.js` — the full
  "create user → create blogs → copy a source folder in → sync changed paths →
  print URLs" flow, promisified. `applyChanges()` shows how to call `sync()` and
  `folder.update()` directly rather than relying on the watcher.
- `app/templates/folders/config.js` — per-handle overrides (`title`, `template`,
  `menu`, `plugins`). Same shape the translate script will want.
- `scripts/blog/create.js` — CLI-shaped blog creation with confirmation prompt.
- `scripts/test/setup-restore-git-test.js` — creates a blog template, enables
  local editing, resolves the on-disk template directory. Near-verbatim reusable.

---


## 3. What Blot does with the files you produce

This is the contract the importer writes against: get these conventions right
and the folder becomes a working site with no further intervention.

### 3.1 The build pipeline

`app/build/README` is thorough; summary of `build(blog, path, callback)`:

1. **Type check** — extension must match an enabled converter, else `WRONGTYPE`.
2. **Draft check** — is the file under a `Drafts` folder.
3. **Conversion** — `app/build/converters/`:
   - always available: `html` (.html/.htm), `img`, `webloc`/.url, `gdoc`
   - Pandoc-dependent (needs `config.pandoc.bin`): `markdown` (.txt/.text/.md/.markdown),
     `docx`, `odt`, `org`, `rtf`. Without Pandoc a `markdown-without-pandoc`
     fallback is used.
4. **Metadata extraction** — `app/build/metadata.js`, three accepted formats
   (§3.3).
5. **Dependency resolution** — rewrites relative `src`/`href` to blog-absolute.
6. **Plugins** — `app/build/plugins/` in series (image, wikilinks, videoEmbeds,
   codeHighlighting, imageCaption, autoImage, externalLinks, linebreaks,
   titlecase, injectTitle, typeset, katex, twitter, bluesky, flickr, zoom,
   mediaPreload, linkScreenshot, analytics, disqus).
7. **Thumbnails** — first image ≥64px; variants small/medium/large/square.
8. **Entry assembly** + `prepare/` — title, summary, teaser, slug, tags, flags,
   permalink, internal links.

`npm start` prints which converters are live:

```
- markdown with pandoc  true/false
- .docx conversion ...
```

Pandoc **is** installed in the dev image (Dockerfile installs 3.6.1), so full
Markdown is available.


### 3.2 Folder conventions — what the crawler must emit

| Convention | Effect | Source |
|---|---|---|
| `Pages/` sub-folder | file becomes a **page**, appears on the menu | `how/sub-folders/pages.html` |
| `Drafts/` sub-folder | not published; a `.html` preview file is written next to it | `how/sub-folders/drafts.html` |
| `Templates/` (or `templates/`) sub-folder | never published; holds locally-edited templates | `app/sync/update/set.js:35` (`isTemplate`) |
| `Public/` sub-folder | served statically, never a post | `app/sync/update/set.js` (`isPublic`) |
| name starts with `_` (file *or* any path segment) | not published, still served as a static asset | `app/build/prepare/isHidden.js`, `how/ignore_file.html` |
| name starts with `.` | ignored | same |
| `[Tag]` in file name or any parent directory | adds that tag; brackets are stripped from the URL | `how/metadata.html`, `build/prepare/tags.js` |
| `YYYY/MM/DD-Name.txt`, `YYYY/MM-DD-Name.txt`, `YYYY-MM-DD-Name.txt`, `YYYY/MM/DD/Name.txt` | sets the publication date | `build/prepare/dateStamp/fromPath.js` |
| date in metadata | **overrides** any date from the path | `how/metadata.html` |
| future date | scheduled post | same |

Note the importer's own path scheme, `app/dashboard/site/import/helper/determine_path.js`:

```
page   → Pages/<slug>
draft  → Drafts/<slug>
dated  → YYYY/MM-DD-<slug>
else   → Undated/<slug>
```

slug via `helper/slugify.js` (spaces → `-`, `&` → `and`, strips `’'.,"”“#?:!`),
truncated to 150 chars, `/` → `-`.

**Adopt this scheme for the translate script** — it is already proven against
WordPress/Squarespace/Blogger/Are.na exports and lines up with Blot's date parsing.


### 3.3 Metadata block formats

All three are accepted (`app/build/metadata.js`, documented in
`app/views/how/metadata.html`):

**Bare key/value at the top of a text file** (must be followed by a blank line,
space required after the colon):

```
Date: January 1st, 2024
Tags: Getting started, Documentation
Link: /introduction

# The post title
```

**HTML comment — must start on line 1 of an `.html` file:**

```html
<!--
Date: January 1st, 2024
Link: /metadata
-->
```

**YAML front matter:**

```
---
Date: January 1st, 2024
Link: Apple
---
```

Recognised keys: `Title`, `Date`, `Link`, `Tags`, `Comments`, `Summary`,
`Search`, `Thumbnail`, `Draft`, `Page`, `Menu`, `Slug`. Anything else becomes
custom metadata available at `{{entry.metadata.<key>}}` (`/developers/guides/custom-metadata`).

`app/dashboard/site/import/helper/insert_metadata.js` shows the exact emission
order used by the existing importers:

```js
Date: YYYY-MM-DD
Tags: a, b
Link: <permalink>
Summary: <summary>
<Capitalized custom keys>: <value>

# <title>

<content>
```


## 4. The shared import waterfall

### 4.1 Reusable importer helpers

`app/dashboard/site/import/helper/index.js` exports the whole toolkit. The
canonical pipeline is `helper/process.js`:

```js
async.waterfall([
  determine_path(output_directory),
  download_audio,
  download_pdfs,
  download_images,
  convert_to_markdown,
  insert_metadata,
  write,
], next)
```

Each step operates on a mutable `post` object with these fields:

`title`, `html`, `content`, `dateStamp`, `created`, `updated`, `tags[]`,
`permalink`, `summary`, `metadata{}`, `draft`, `page`, `slug`, `path`,
`asset_directory`.

Notable helpers:

- **`convert_to_markdown.js`** — Turndown + `turndown-plugin-gfm`, bullet `-`,
  fenced code, `*` emphasis, `turndown.escape` overridden to a no-op (so Markdown
  already embedded in HTML survives), keeps `audio`/`video`/`iframe`. Only runs
  when `post.content === undefined`.
- **`to_markdown.js`** — an older/alternative Turndown config that keeps
  `<figure>`, reverses footnotes into `[^n]` syntax, and has an
  `isAlreadyMarkdown()` heuristic. Not in the standard waterfall.
- **`download_images.js`** — cheerio-walks `img[src]`, `fetch`es each (actual
  timeout is 5 s; the constant's comment and the error message both say 10 s and
  are wrong), sniffs format with `sharp`,
  names the file from `Content-Disposition` → URL basename → `"image"`,
  sanitises, **prefixes with `_`** so the asset is not published as its own post,
  ensures an extension, writes into the staged asset directory, and rewrites
  `src` to the bare filename. Also handles `post.metadata.thumbnail`.
- **`asset_directory.js`** — stages assets in `os.tmpdir()/blot-import-*` so they
  do not influence final path allocation.
- **`write.js` / `write.createWriter()`** — the important one. If the post has any
  assets, it writes `<basePath>/post.txt` and moves the assets in beside it;
  otherwise `<basePath>.txt`. Reserves paths across a batch so two posts with the
  same title do not clobber each other (`-2`, `-3` suffixes). Sets `mtime` from
  `post.updated || post.created || post.dateStamp`.
- **`resolve_url.js`** — resolves all relative `href`/`src` against a base URL.
  Directly useful for a crawler.
- **`insert_video_embeds.js`**, **`replace_embeds.js`** — WordPress shortcodes and
  iframes → bare YouTube/Vimeo URLs (Blot's `videoEmbeds` plugin re-embeds them).
- **`normalize_identifier.js`** — safe human-facing names (120 chars / 240 bytes,
  strips control and unsafe chars, rejects Windows reserved names).


### 4.2 Existing importer sources — what to model this on

```
sources/wordpress   XML (WXR) → items → extract_entry → tidy → …
sources/squarespace delegates entirely to the WordPress converter
sources/blogger     Atom export
sources/arena       Are.na HTTP JSON API  ← the only network-sourced importer
```

`sources/arena/router.js` + `index.js` + `posts.js` + `parse.js` is the closest
model for a URL-driven import: validate the URL, page through a remote source,
and funnel each item through the same waterfall.

**There is no HTML-crawling importer today.** This is genuinely new work — every
existing source consumes a structured export or an API, never rendered HTML.

**These four are out of scope as *features*, but they are the reference for how a
source is built.** If the operator's target site is WordPress, Squarespace, Blogger
or Are.na, the answer is Blot's dashboard importer, not this script (§0). Their
value here is the shape: each produces `post` objects and hands them to the same
waterfall, and `sources/wordpress/item/tidy.js` in particular is a catalogue of the
HTML-cleaning problems this crawler will hit — stray shortcodes, missing `<p>`
tags, captions, inline images.


## 5. The crawler

### 5.1 Mechanical in Node, judgement in Claude

**Design decision: the importer fetches and cleans HTML, then hands it to the
existing pipeline. Claude does the extraction and the editorial judgement.**

The split follows the existing sources exactly. Every source in the tree does the
same two things — produce a `post` object, then run it through the shared
waterfall. The HTML importer is no different; only the "produce a `post` object"
half is novel, and that half is where a model earns its keep.

**The `post` contract** (the interface between the two halves). Every field the
waterfall consumes, gathered from `extract_entry.js`, `arena/parse.js#normalizeText`
and `insert_metadata.js`:

```js
{
  title:      String,          // → "# title" appended after the metadata block
  html:       String,          // → converted to Markdown by convert_to_markdown
  content:    String,          // optional; if set, convert_to_markdown is a no-op
  dateStamp:  Number,          // ms → "Date: YYYY-MM-DD" and the YYYY/MM-DD- path
  created:    Number,          // ms
  updated:    Number,          // ms → the written file's mtime
  tags:       [String],        // → "Tags: a, b"
  permalink:  String,          // → "Link: /original/path"  (preserves inbound links)
  summary:    String,          // → "Summary: …"
  metadata:   { key: value },  // → "Key: value" per entry, capitalized
  draft:      Boolean,         // → Drafts/<slug>
  page:       Boolean,         // → Pages/<slug>
  slug:       String,          // → overrides the title when deriving the filename
}
```

Note `convert_to_markdown` only runs when `post.content === undefined`. So Claude
can hand back either raw HTML (let Turndown convert it) or finished Markdown
(set `content` directly and the pipeline passes it through). Prefer handing back
`html` — Turndown's configuration is shared with every other importer, which is
the whole point of routing through the pipeline.

**Node's half — fetch and clean:**

1. **Discovery.** Try `/sitemap.xml`, then `/feed`, `/feed.rss`, `/rss`,
   `/atom.xml`, `/index.xml`, `/feed.json`; fall back to following same-origin
   links from the homepage with a depth/page cap. `xml2js` is already a
   dependency (the WordPress and Blogger importers use it).
2. **Fetch — decided: puppeteer for every page, no fetch-first path.** Rendering
   in a real browser means the crawler sees the same DOM a reader does: JS-rendered
   content, lazy-loaded images resolved, client-side routing followed. The failure
   mode it avoids — silently capturing an empty app shell and producing a folder
   of blank posts — is the worst one available here, because it looks like success.

   **Implementation notes.** Launch **one** browser and reuse it across pages
   (`browser.newPage()` per page, close the page after), as `app/helper/screenshot`
   does; launching per page would be pathologically slow. Reuse
   `app/helper/screenshot/args.js` for the launch flags — they are already tuned
   for the Alpine container (`--no-sandbox`, `--disable-gpu`, `--disable-dev-shm`
   family). The container has Chromium at `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser`
   (Dockerfile), so `crawl.js` can run in-container; **verify outbound internet
   from the container works** before relying on it, since nothing else in the tree
   fetches arbitrary external sites from there. Wait on `networkidle0` with a
   bounded timeout and treat a timeout as a soft failure — capture what rendered
   rather than dropping the page.

   Combined with serial fetching (below) this is deliberately slow. That is
   acceptable: a translation is a one-off, and correctness beats throughput.

   **Decided limits: one request at a time, no page cap, warn at 1000 pages.**
   Serial fetching is the politeness mechanism — it needs no delay tuning, it is
   trivially correct, and it keeps the load on someone else's live server to
   roughly what a single reader generates. No page cap means large archives
   translate in one pass rather than silently truncating, which is the failure
   mode that would be hardest to notice. The warning at 1000 pages is the
   backstop against a crawler that has escaped its boundary (a calendar,
   a paginated tag index, an infinite filter permutation) — print it, keep going,
   and let the operator interrupt. Consider also logging progress every N pages so
   a long crawl does not look hung.

   None of the existing importers rate-limit at all, because they consume
   user-supplied export files rather than hitting a live server; this is the first
   code in the tree that needs to be a well-behaved client.
3. **Clean.** `resolve_url.js` first (absolutises every `href`/`src` against the
   page URL — otherwise `download_images` cannot fetch anything), then strip
   scripts, styles, tracking pixels and obvious chrome with `cheerio`. Keep this
   conservative: over-stripping destroys content, and Claude can prune further.
4. **Hand off.** Emit one JSON record per page — URL, title candidates, publish
   date candidates, the cleaned HTML, and any `<meta>`/JSON-LD/microdata found.

**Claude's half — extraction and editorial judgement.** Per page: which subtree is
the actual content, what the real title and date are, whether it is a post or a
page (`Pages/`), and what tags apply. Across the whole site: the structural
decisions that a heuristic cannot make —

- **Tag strategy.** Does the source have categories, a tag cloud, section
  directories, or a topic structure implied by URLs? Blot tags can be set in
  metadata *or* in the path via `[Brackets]` (and the two are merged), so a
  section-per-directory source can become `[Section]/post.txt` and get tag pages
  at `/tagged/section` for free. This is exactly the kind of mapping worth
  spending a model on.
- **Pages vs posts.** Sites usually mix a handful of standing pages with a dated
  stream. Getting the split right drives the menu, the archives, and the homepage.
- **Landing page.** If the source homepage is bespoke rather than a post list, it
  becomes a page with `Link: /` (`how/sub-folders/pages.html`), and the post list
  moves to `/page/1`.
- **Dates.** Prefer a real publication date from the page; fall back to
  `Undated/` (`determine_path.js`) rather than inventing one.
- **Permalink preservation.** Setting `permalink` to the source path keeps inbound
  links and old URLs working. Cheap, and easy to forget.

**Why route through the pipeline rather than writing files directly:** consistency
is the point. `write.createWriter()` handles the `post.txt`-in-a-directory form
when a post has assets and reserves paths across the batch so same-titled posts do
not clobber each other; `download_images` handles `Content-Disposition` filenames,
format sniffing and the `_` asset prefix; `determine_path` produces the date-path
scheme Blot parses back out. Reimplementing any of that would drift.

**Suggested module split:**

```
crawl.js     discovery + fetch + clean → JSON records        (Node, in container)
extract.js   JSON records → post objects                     (Claude)
build.js     post objects → helper/process waterfall → files (Node, in container)
```

`app/dashboard/site/import/helper/process.js` is `build.js` almost verbatim; it
needs `preserve_output_directory: true` (it calls `fs.emptyDirSync` otherwise) and
its `process.exit()` on completion removed.


---

## 6. Wiring it together

### 6.1 Proposed shape

```
scripts/development/dynamic-importer/
  RESEARCH.md          ← this file
  index.js             ← IN container: provision the scratch blog (idempotent)
  crawl.js             ← IN container: discovery, fetch, clean → JSON records.
                          Accepts an optional path prefix for scoped re-crawl
  build.js             ← IN container: post objects → import waterfall → files
  state.js             ← run-state read/write for idempotent re-runs
  dynamic-importer.sh  ← host entrypoint referenced by package.json
  prompt.md            ← the Claude Code brief (extraction + editorial rules)
```

```json
"dynamic-importer": "./scripts/development/dynamic-importer/dynamic-importer.sh"
```

Flow:

1. **preflight** — `docker ps` for `blot-node-app-1`, then `GET https://<host>/health`;
   abort with "run `npm start` in another window" (§1.5). Resolve the host via
   `docker exec blot-node-app-1 node -e 'console.log(require("config").host)'`.
2. validate `<url>`, derive a stable alnum handle, load run state.
3. `docker exec … node scripts/development/dynamic-importer <url> <handle>` →
   provisions or reuses the scratch blog, `git init`s the folder, prints `blogID`
   and site URL as parseable output.
4. `crawl.js` → JSON records in `.verification/records/`.
5. `claude -p …` in the blog folder — extraction and editorial judgement (§6.3),
   then `build.js` to run the waterfall. Commit the raw result before any fixes.
6. wait for the rebuild to settle — poll `blog.cacheID` until stable (§1.2).
7. agent verifies conversion fidelity against the live source (§6.4); fixes
   class-wide problems; commits.
8. print the folder path and the scratch site URL, and remind the operator that
   the content is ready to copy into a `translate` site.

### 6.2 Invoking the Claude Code CLI

Identical mechanics to the translate script — see
`scripts/development/translate/RESEARCH.md` §6.3 for the full flag rationale.
Summary:

- `claude -p --output-format json --permission-mode acceptEdits`, run **on the
  host** (the container has no `claude` binary and no credentials).
- `--session-id` on the first run, `--resume` on subsequent turns so operator
  feedback lands in a session that remembers what it extracted.
- **Blocking:** non-zero exit is fatal; plus an explicit `.verification/BLOCKED.txt`
  the agent writes when it cannot proceed, which the wrapper checks and surfaces as
  the abort reason. `set -euo pipefail` in the shell wrapper, as every other script
  in `scripts/development/` already uses.
- `--max-budget-usd` and a process timeout, since a large archive is the case where
  an unbounded loop hurts.
- Tool allowlist `Read, Write, Edit, Glob, Grep, WebFetch, Bash(node:*)` — **not**
  unrestricted `Bash`. This script's entire input is untrusted third-party HTML, so
  the guardrails matter more here than anywhere else in the project.

### 6.3 What the agent is asked to do

**Step 1 — extract.** Turn each crawled record into a `post` object (§5.1). Decide
per page: which subtree is the actual content, the real title and publication date,
post vs page, and which tags apply.

**Step 2 — structure.** The site-wide editorial calls that a heuristic cannot make:
tag strategy, the pages/posts split, whether the homepage is a bespoke landing page
(`Link: /`) or a post list, and permalink preservation. These are described in §5.1
and they are the main reason a model is in this loop at all.

**Step 3 — build.** Run the objects through the shared waterfall (§4.1) rather than
writing files by hand. Commit the raw output before touching it.

**Step 4 — verify and fix.** Sample deeply, identify recurring artefacts, apply a
fix pass across every post, re-sample to confirm (§6.4).

The brief should carry: the `post` contract (§5.1), the folder conventions (§3.2),
the metadata formats (§3.3), and the crawl limits (§5.1). It should **not** carry
template material — this agent never touches `Templates/`.

Keep the brief in `scripts/development/dynamic-importer/` and pass `--add-dir`
rather than writing it into the blog folder, or it becomes part of the content.

### 6.4 Verification: did the content actually convert?

Different question from the translate script's. That one asks "does it look like
the source site"; this one asks "did the writing survive". Screenshots still help,
but the checks are mostly structural:

- **Did every page become an entry?** Compare the crawl record count against
  `Entries.getAllIDs` minus soft-deleted ones. A silent drop means a converter
  rejected the file (`WRONGTYPE`) or a path collided.
- **Did anything fail to build?** Entries with empty `html`, or files Blot ignored
  entirely, are the loud failures.
- **Spot-render against the source.** Screenshot a source page and the
  corresponding entry on the scratch site side by side. This catches lost images,
  broken embeds, mangled code blocks and collapsed formatting far faster than
  reading Markdown.
- **Sample deeply, fix class-wide, re-sample** — the same procedure the translate
  research settled on for importer output, and for the same reason: crawler
  artefacts are recurring, not random.

```
1. sample ~10 posts spanning eras and formats (image-heavy, code, embeds, tables)
2. identify recurring artefacts — nav chrome left in, duplicated titles,
   broken relative links, lost figure captions
3. write and apply a fix pass across every post
4. re-sample a different set to confirm
```

Committing the raw crawl output first (§6.6) is what makes step 3 safe: the fix
pass is a reviewable diff over known-original input, and a bad pass is a revert.

`.verification/` holds the screenshots, the crawl records and the agent's notes.
It is dot-named so macOS Finder's select-all excludes it when the operator zips or
copies the content out — see the translate research §6.4 for the verified
behaviour, which is identical here.

### 6.5 Idempotency and re-runs

Re-running against the same URL should continue, not start over.

- **Detect** via a run-state file at `data/tmp/dynamic-importer/<handle>.json`
  (`helper/tempDir()`), holding the source URL, `blogID`, handle, Claude
  `--session-id`, run count and timestamps. Outside the blog folder so it never
  travels with the content.
- **Provisioning is naturally idempotent** if you reuse the blog by handle —
  `app/templates/folders/setupBlogs.js` is the precedent (reuse if it exists, throw
  if owned by another user, otherwise create).
- **Scoped re-crawl.** `--recrawl [path]` re-fetches everything or only URLs under
  a path prefix. The mechanical trap: `helper/process.js` calls
  `fs.emptyDirSync(output_directory)` unless `options.preserve_output_directory` is
  set, and `write.createWriter()` appends `-2`/`-3` suffixes when a path is taken.
  So preserve-on **duplicates** every post in scope, and preserve-off **wipes** the
  agent's fixes. A scoped re-crawl must delete exactly the paths it is about to
  rewrite, then run the waterfall over just those pages.
- **Screenshots and records** overwrite in place so `.verification/` always reflects
  the latest run.

### 6.6 Version control

`git init` the scratch blog folder at provisioning, and have the agent commit as it
goes — after the raw crawl, after the extraction pass, after each fix pass. The
payoff is specific to this tool: **the diff between "what the crawler produced" and
"what the agent fixed" is the main artefact for judging whether the extraction is
working.**

Commit `4d276a06a` added `ignored: shouldIgnoreFile` to the local client's chokidar
watcher, so git operations no longer trigger sync cycles (measured: 42 → 1 for
`git init` + commit, 0 for a commit with no content change). No workaround needed.

Add a `.gitignore` excluding `.verification/` — the screenshots and crawl records
are large and regenerated every run.

History stays local; it is a working tool, not part of what the operator hands on.

### 6.7 Forcing a rebuild if the watcher misses changes

The watcher is proven (§1.2) but sync latency is variable, so wait for
`blog.cacheID` to stop changing rather than polling immediately. If an explicit
rebuild is ever needed:

```js
const sync = require("sync");
sync(blogID, (err, folder, done) => {
  folder.update("/path/that/changed", () => done(null, () => {}));
});
```

`app/templates/folders/index.js#applyChanges` is a promisified working version that
also calls `sync/fix`.

---

## 7. Decisions and open questions

### 7.1 Settled

| Question | Decision | Where |
|---|---|---|
| Scope | Crawling only. Platform exports go through Blot's existing dashboard importers | §0 |
| Dashboard feature? | **No** — operator script, permanently | §0 |
| Output | A folder of content, plus a throwaway scratch site for inspection | §0 |
| Dev account | `example@example.com` — a hardcoded literal, not config | §2.1 |
| Starting the stack | No. Preflight against `/health` and abort | §1.5 |
| Crawler rendering | Puppeteer for every page; no fetch-first path | §5.1 |
| Crawl limits | One request at a time, no page cap, warn at 1000 pages | §5.1 |
| Content extraction | Node fetches and cleans, Claude extracts and makes editorial calls; they meet at the `post` object and go through the shared waterfall | §5.1 |
| Review depth | Sample deeply, fix class-wide, re-sample | §6.4 |
| Invoking Claude | `claude -p` on the host; non-zero exit or `.verification/BLOCKED.txt` aborts | §6.2 |
| Version control | Plain `git init` in the folder; history stays local | §6.6 |
| Verification folder | `.verification/` — dot-named so Finder select-all excludes it | §6.4 |

### 7.2 Defaults taken

| Question | Default |
|---|---|
| Run-state location | `data/tmp/dynamic-importer/<handle>.json` via `helper/tempDir()` |
| Handle derivation | Deterministic from the URL: strip scheme, `www.` and TLD, lowercase, strip to alnum, numeric suffix on collision. Must be stable across runs |
| Rebuild wait | Poll `blog.cacheID` until it stops changing. Settle *before* screenshotting — `.verification/` is not watcher-ignored, so writing screenshots bumps `cacheID` too |
| Tool allowlist | `Read, Write, Edit, Glob, Grep, WebFetch, Bash(node:*)` — no unrestricted `Bash` |

### 7.3 Still open

1. **Verify outbound internet from the container.** Nothing else in the tree
   fetches arbitrary external sites from `blot-node-app-1`. If it is blocked or
   proxied, `crawl.js` moves to the host, which also means puppeteer runs against
   the host's `node_modules` (24.1.1, browser in `~/.cache/puppeteer/chrome`)
   rather than the container's Chromium. **Worth testing first — it decides where
   the crawler lives.**
2. **Discovery order and stopping rules.** `/sitemap.xml` → feeds → same-origin
   link following is the sketch (§5.1), but the stopping rule for link-following on
   a site with no sitemap needs pinning down — that is where a crawler escapes into
   calendars and filter permutations.
3. **How much cleaning Node should do before the agent sees the HTML** (§5.1).
   Too little wastes tokens on boilerplate; too much destroys content the agent
   needed. Start conservative.
4. **What the handoff to `translate` looks like in practice** — the operator copies
   content out of this scratch folder into a translate-scaffolded one. Worth a
   printed one-liner (`cp -R` excluding `Templates/`, `.git`, `.verification/`),
   or a small helper, rather than leaving it to be worked out each time.
5. **Whether the manifest is worth producing** — a summary of what the crawl found
   (sections, taxonomies, date range, post counts, page-vs-post split, media
   density) would give the translate agent context it otherwise has to rediscover
   by reading the folder. Cheap to emit here, useful there.

---

## 8. File index

**Environment**
```
scripts/development/{start.sh,docker-compose.yml,open-folder-server.js}
Dockerfile                                NODE_PATH, pandoc, sharp/vips, chromium
config/index.js                           host, protocol, directories, cdn
app/server.js:116  app/site/index.js:49   GET /health
scripts/development/proxy/setup.sh                 mkcert wildcard cert into data/ssl
/etc/resolver/blot                        nameserver 127.0.0.1 → *.blot wildcard
```

**Provisioning**
```
app/configure-local-blogs.js              dev user/blog bootstrap (hardcoded email)
app/models/blog/create.js  defaults.js    Blog.create + defaults
app/models/blog/validate/handle.js        handle rules + banned.txt
app/clients/local/{README,setup.js,init.js}
app/clients/local/init.js:46              channel payload must be JSON
app/templates/folders/{index.js,setupUser.js,setupBlogs.js}
scripts/blog/create.js                    CLI blog creation
```

**What Blot does with the files**
```
app/build/README                          the whole build pipeline
app/build/metadata.js                     metadata block parsing
app/build/prepare/{title,tags,teaser,summary,isHidden,permalink}.js
app/build/prepare/dateStamp/{index,fromPath,fromMetadata}.js
app/sync/{index.js,update/set.js}         sync + Public/Templates/_ exclusions
app/views/how/metadata.html               user-facing metadata reference
app/views/how/sub-folders/*.html          Pages / Drafts / Templates
app/views/how/ignore_file.html            underscore convention
```

**The import waterfall**
```
app/dashboard/site/import/helper/index.js       the toolkit
app/dashboard/site/import/helper/process.js     the canonical waterfall
app/dashboard/site/import/helper/determine_path.js
app/dashboard/site/import/helper/download_images.js
app/dashboard/site/import/helper/convert_to_markdown.js
app/dashboard/site/import/helper/insert_metadata.js
app/dashboard/site/import/helper/write.js       createWriter, post.txt form
app/dashboard/site/import/helper/resolve_url.js absolutise before downloading
app/dashboard/site/import/sources/arena/        the only network-sourced importer
app/dashboard/site/import/sources/wordpress/    out of scope, but the best-worn path
```

**Crawling and verification**
```
app/helper/screenshot/index.js            screenshot(site, path, options)
app/helper/screenshot/args.js             chromium flags tuned for Alpine
node_modules/puppeteer (host, 24.1.1)     + ~/.cache/puppeteer/chrome
app/blog/render/middleware.js:110         ?json=true / ?debug=true
app/models/entries/getAllIDs              note: includes soft-deleted entries
```

**Related**
```
scripts/development/translate/RESEARCH.md  the template-building companion tool
```
