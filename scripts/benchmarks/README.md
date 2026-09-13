# Blot benchmarks

Reproducible build + render benchmarks for a Blot blog, plus the CI plumbing
that turns them into a PR comment and a master-branch regression watch.

## The four workflows

| Workflow | Trigger | Scale | What it measures |
|---|---|---|---|
| [`benchmarks.yml`](../../.github/workflows/benchmarks.yml) | every PR/push | small, built fresh every run (5 sites / 1000 files) | build + render + burst phases, smoke-scale |
| [`benchmarks-corpus.yml`](../../.github/workflows/benchmarks-corpus.yml) | weekly + manual | large (1000 sites / ~160k posts) | nothing directly - builds and caches the corpus the next workflow reads |
| [`benchmarks-render.yml`](../../.github/workflows/benchmarks-render.yml) | PR/push touching render-critical paths | the cached large corpus | render + burst phases only, against realistic production-shaped data |
| [`benchmarks-converters.yml`](../../.github/workflows/benchmarks-converters.yml) | PR/push touching `app/build/converters/**` | tiny (a converter's own test fixtures) | per-converter conversion timing, in-process |

`benchmarks.yml` is unchanged in behavior from before this document's corpus
additions - it's the fast, always-on smoke check. The other three are
additive: deeper signal on the workloads/code paths where the smoke check's
5-site corpus doesn't tell you much.

## What it measures

One run creates `--sites` blogs, writes `--files` generated text entries plus a
fixed set of converter fixtures (markdown, docx, rtf, odt, org, images, gdoc —
reused from `app/build/converters/*/tests`), then:

| Phase      | What happens                                                    | Headline metrics |
|------------|----------------------------------------------------------------|------------------|
| **build**  | write the workload to disk, then `blog.rebuild()` every site   | per-site wall time p95, peak RSS, CPU %, disk I/O ops |
| **render** | fetch every URL in each blog's sitemap and read the full body  | per-page wall time p95, peak RSS, CPU %, disk I/O ops, output bytes/page |
| **tag burst** | for each site, request several distinct `/tagged/<slug>` pages once solo (uncontended) and once as a genuine concurrent burst | burst p50/p95, burst ÷ solo inflation ratio |
| **archives burst** | request `/archives` (repeating blogs round-robin if there are fewer sites than the concurrency) once solo per target and once as a genuine concurrent burst | burst p50/p95, burst ÷ solo inflation ratio |
| **search burst** | for each site, request several distinct `/search?q=<keyword>` queries once solo and once as a genuine concurrent burst | burst p50/p95, burst ÷ solo inflation ratio |
| **sitemap burst** | request `/sitemap.xml` (same round-robin rule as archives) once solo per target and once as a genuine concurrent burst | burst p50/p95, burst ÷ solo inflation ratio |
| **backlinks burst** | request each site's "hub" entry — linked to by ~25% of its other entries — (same round-robin rule) once solo and once as a genuine concurrent burst | burst p50/p95, burst ÷ solo inflation ratio |
| **not-found burst** | request guaranteed-nonexistent paths (same round-robin rule) once solo and once as a genuine concurrent burst | burst p50/p95, burst ÷ solo inflation ratio |

Build and render p50 are still recorded in the raw result JSON alongside p95,
but the PR-comment table only tracks p95 — it's the more useful signal for
catching regressions, and a p50 row next to it was mostly redundant.

Every burst phase's full p50/p95 and inflation ratio is kept in the raw result
JSON (and in `samples` when aggregated across iterations), but the PR-comment
table only tracks one row across all six phases — `render_burst_inflation_avg`,
the mean of the six inflation ratios — so a table with the general build/render
metrics doesn't balloon into a dozen near-duplicate rows. Dig into the raw JSON
if you need to know which specific route regressed.

Each generated entry also gets 1-4 tags drawn from a `--tags` (default 40)
pool, so `/tagged/<slug>` pages exist with a realistic number of matching
entries — modelled on a real customer blog (~800 entries, ~40 tags) that hit
severe request-queueing slowdowns when several distinct tag pages were
requested at once. The **tag burst** phase reproduces that directly: it times
`--tag-burst-concurrency` (default 8) distinct tag pages one at a time, then
fires the same pages all at once with `Promise.all` (not the render phase's
pooled queue) and compares the two. On a healthy render path the inflation
ratio stays close to 1×; requests queueing behind synchronous, uncached
per-request work blows it up, same as the render-phase pooled queue does but
isolated to a controlled, always-the-same-N-pages burst so the signal is
comparable run to run.

The **archives burst** phase reproduces the same failure mode from the other
direction. `/archives` (like `/tagged/<slug>`) pulls the full entry set via
`Entries.getAll` and does a synchronous year/month grouping pass with
per-entry `moment.tz` formatting on every request — see
[`archives.js`](../../app/blog/render/retrieve/archives.js) — but there is
only one `/archives` URL per blog, so there's no "distinct pages" axis to
burst along. Instead it fires `--archives-burst-concurrency` (default 8)
concurrent `/archives` requests, cycling through the benchmark's `--sites`
round-robin when there are fewer blogs than the requested concurrency. With
the default multi-site config this reproduces cross-customer contention
(many blogs sharing one Node process each landing on their own `/archives` at
once); with `--sites 1` it instead reproduces many tabs/crawlers hitting one
big blog's `/archives` at the same time.

Each entry also has a ~35% chance of mentioning one of `--search-keywords`
(default 15) distinct keywords, guaranteeing realistic, non-trivial result
sets for the **search burst** phase. It targets
[`Entry.search`](../../app/models/entry/search.js), which scans a blog's
entries in chunks of 200 and, per chunk, synchronously concatenates and
substring-matches against every candidate's *full HTML* — uncached, redone
from scratch every request. `--search-burst-concurrency` (default 8) distinct
`/search?q=...` queries are timed solo, then fired again as one burst, same
pattern as the tag burst. Concurrent site search by several visitors is a
realistic traffic pattern in its own right, not just another way to trigger
the queueing bug.

The **sitemap burst** phase is the archives burst's sibling: `/sitemap.xml`
(see [`sitemap.xml`](../../app/templates/source/blog/sitemap.xml)) iterates
`{{#all_entries}}` over the full entry set on every request just like
`archives.js`, and like archives there's only one sitemap URL per blog, so
`--sitemap-burst-concurrency` (default 8) requests cycle round-robin across
`--sites`. Kept as a separate phase (rather than folded into the archives
burst) because it's a genuinely distinct customer-facing URL and traffic
pattern — search engines and other crawlers routinely fetch several blogs'
sitemaps around the same time.

Each site's workload also includes one "hub" entry that ~25% of its other
entries link to, so it accumulates a realistic backlinks list. Rendering an
entry runs [`augment.js`](../../app/blog/render/load/augment.js), which does
an `async.map` over `entry.backlinks`, issuing one uncached `Entry.getByUrl`
Redis round trip per backlink. The **backlinks burst** phase fires
`--backlinks-burst-concurrency` (default 8) concurrent requests at each
site's hub entry (same round-robin rule as archives/sitemap) to see whether
that per-render N+1 fan-out serializes under concurrent load.

Every other phase only ever requests pages that exist. The **not-found
burst** targets the opposite case: paths guaranteed not to have been written
by the workload. A 404 goes through
[`app/blog/routes/error.js`](../../app/blog/routes/error.js)'s catch-all
middleware, which renders `error.html` via the same uncached, per-request
`retrieve()` path as `/archives` and `/search` (only the compiled template is
cached, not the rendered output) and also fires an unawaited `store404()`
Redis write to log the miss for the dashboard. Dead links, scanners and
mistyped URLs make error routes real production traffic, so
`--not-found-burst-concurrency` (default 8) requests to guaranteed-404 paths
(same round-robin rule as archives/sitemap/backlinks) are timed solo and then
as a genuine concurrent burst, same pattern as the other burst phases.

Everything is seeded (`--seed`, default `blot-benchmark-seed`) so the generated
workload is identical from run to run. The full result is written as JSON; the
tracked-metric list lives in [`lib/metrics.js`](lib/metrics.js).

## The skewed, production-shaped workload (`--distribution skewed`)

The flat mode above (`--distribution flat`, the default, used by
`benchmarks.yml`) spreads `--files` evenly across `--sites`. Real Blot traffic
isn't shaped like that: a handful of customer blogs have many thousands of
posts and tags, and most have a handful. `--distribution skewed` (in
[`spec/util/workload.js`](spec/util/workload.js)) draws a log-normal weight
per site (Box-Muller, seeded, with a ~1% chance of a "mega site" 40x
multiplier for extra tail), then allocates `--files` proportionally to those
weights so a few sites dominate. Tag and search-keyword pool sizes scale the
same way per site, so bigger sites also get proportionally more tags/keywords/
backlink structure, not just more posts.

This mode is additive: it doesn't change flat mode's shape or defaults, so it
did not require a `historySchemaVersion` bump (see below) - only
`corpusSchemaVersion` (a separate constant, for the corpus artifacts
themselves) needed bumping.

Its production-scale defaults (`corpusSites: 1000`, `corpusFiles: 160000`,
`corpusMediaFraction: 0.2`) live in [`spec/util/defaults.js`](spec/util/defaults.js)
and are what `build-corpus.js` uses unless overridden.

## The shared media pool and hard-link trick

A configurable fraction of posts (`--media-fraction`, 0 by default, 0.2 in the
corpus defaults) reference an image or GIF. Rather than writing unique media
bytes per post - expensive at 160k posts - [`lib/generate-media.js`](lib/generate-media.js)
generates a small, fixed (~24 file) pool of genuinely valid JPEG/PNG photos
(synthesized gradients via `sharp`, palette-quantized/mozjpeg'd to stay tiny),
short animated GIFs (`sharp` frames assembled with ImageMagick's `convert`),
and a couple of hand-written SVGs - deterministically, from `--seed`, into
`data/blogs/_benchmark-media-pool/` (a fixed directory *inside*
`config.blog_folder_dir`, sibling to the per-blog folders) the first time a
run needs media. Nothing here is committed to git; the pool is regenerated
fresh (idempotently - only if missing) by every run that requests media.

Each post that wants media gets a **hard link** (`fs.link`, not a symlink) to
one of the pool files, picked pseudo-randomly from the same seeded RNG. This
is deliberately a hard link: [`app/helper/assertNoSymlinks.js`](../../app/helper/assertNoSymlinks.js)
is called on every path inside a blog folder during sync
([`app/sync/update/index.js`](../../app/sync/update/index.js)) and when
serving assets ([`app/blog/routes/assets.js`](../../app/blog/routes/assets.js)),
and unconditionally rejects any symlink - including the final path component
itself - with `ELOOP`. A hard link is indistinguishable from an ordinary file
to `lstat()`, so it passes that check, and because every post referencing the
same pool file shares one inode, `tar` still only stores that file's bytes
once per archive (subsequent hard-linked paths become link references) - so
`data/blogs/` stays small exactly like a symlink approach would have, without
tripping the no-symlinks guard. Putting the pool inside `data/blogs/` (rather
than, say, the git checkout) also means it's swept up for free by whatever
already tars/restores `data/blogs` (see the corpus lifecycle below), so a
restored corpus's hard links keep resolving without needing a fourth cached
artifact.

## The corpus build/cache/restore lifecycle

Building the full 1000-site / ~160k-post corpus from scratch takes long
enough that no PR should pay for it. Instead:

1. **[`benchmarks-corpus.yml`](../../.github/workflows/benchmarks-corpus.yml)**
   (weekly + `workflow_dispatch`) builds it once via
   [`build-corpus.js`](build-corpus.js): spins up Docker + a throwaway Redis,
   runs the spec in `--corpus-mode build` (generate the skewed workload,
   `blog.rebuild()` every site, then stop - no render/burst phases), then
   snapshots three artifacts into `.benchmarks/corpus/`:
   - `redis-dump.rdb` - a Redis `SAVE` dump of every entry/tag/index key
   - `blogs.tar.gz` - `data/blogs/` (raw source + hard-linked media - small)
   - `static.tar.gz` - `data/static/` (derived/build output - the expensive
     part to regenerate)

   plus `manifest.json` (blog IDs/handles, and each site's tags/search
   keywords/hub path, so a later render-only run doesn't need to recompute
   the workload). All four are saved to the Actions cache under
   `benchmark-corpus-v<CORPUS_SCHEMA_VERSION>-<run-id>` (same
   restore-keys-prefix idiom as the history cache below) and backed up as a
   90-day `benchmark-corpus-artifacts` upload-artifact.
   [`seed-corpus.js`](seed-corpus.js) (the corpus's counterpart to
   [`seed-history.js`](seed-history.js)) restores from that artifact if the
   cache is ever completely missing.

2. **[`benchmarks-render.yml`](../../.github/workflows/benchmarks-render.yml)**
   (PR/push touching render-critical paths) restores the newest matching
   corpus cache (read-only - it never saves back an amended corpus), loads
   the Redis dump into its job's `redis:6` service container (`docker cp` the
   dump into the container's `/data/dump.rdb`, then `redis-cli DEBUG RELOAD`
   to make the running server pick it up without a restart), extracts the two
   tarballs into place, then runs the spec in `--corpus-mode render`: skip
   workload generation and `blog.rebuild()` entirely and just run the render
   + burst phases against what's already there. History/regression tracking
   is entirely separate from `benchmarks.yml` (`render-benchmarks-history-
   <arch>` cache key, its own sticky PR comment, its own issue label) since
   the workload shapes aren't comparable metric for metric.

`CORPUS_SCHEMA_VERSION` (a workflow env, mirrored as `corpusSchemaVersion` in
`defaults.js`) is independent of `historySchemaVersion`: bump it whenever the
corpus's *shape* changes (site/post/tag/media distribution, the hard-link
layout, the converter fixture set) so a stale cached corpus doesn't silently
get reused against code that no longer matches its assumptions.

## Running it locally

Requires Docker (the benchmark runs inside the `dev` image against a throwaway
Redis container).

```bash
# One run, prints a summary table
npm run benchmark

# Compare the working tree against another branch / ref
npm run benchmark -- master
npm run benchmark -- origin/some-feature-branch
```

`npm run benchmark` is [`compare.js`](compare.js): with no argument it just runs
once; with a ref it benchmarks the working tree and that ref in a throwaway
worktree and prints a side-by-side table ([`format-diff.js`](format-diff.js)).

Lower-level knobs (passed through to [`index.js`](index.js)):

```bash
node scripts/benchmarks --help
node scripts/benchmarks --sites 3 --files 500 --output /tmp/result.json
BENCHMARK_DEBUG=1 node scripts/benchmarks        # verbose sitemap expansion
```

Defaults for every knob live in one place:
[`spec/util/defaults.js`](spec/util/defaults.js).

### Rehearsing the skewed/corpus mode locally

A full 1000-site / ~160k-post corpus build is slow locally too (that's the
whole reason it's cached in CI). Rehearse the same code path at a much
smaller scale instead:

```bash
# Skewed distribution + media, small scale
node scripts/benchmarks --distribution skewed --sites 20 --files 2000 --media-fraction 0.2

# Full build-corpus.js flow (Docker + throwaway Redis + all three artifacts),
# small scale
node scripts/benchmarks/build-corpus.js --sites 20 --files 2000 --out-dir /tmp/corpus-rehearsal

# Then, against that small corpus, the render-only mode:
node scripts/benchmarks --corpus-mode render \
  --corpus-manifest-path /tmp/corpus-rehearsal/manifest.json
```

The last command needs the corpus's Redis dump already loaded and its
`data/blogs`/`data/static` tarballs already extracted into wherever your
local container mounts `/usr/src/app/data` - `build-corpus.js` writes its
working `data/` under `--out-dir` for exactly this reason.

### Per-converter benchmark

```bash
NODE_PATH=app node scripts/benchmarks/converter-bench.js --converter markdown --converter img --n 50
```

No Docker needed for most converters - see "Per-converter benchmarks" below.
The `img` converter is the exception: its AVIF/WebP/HEIC fixtures go through
`app/helper/transformer`, which needs a Redis server reachable at
`config.redis` (`127.0.0.1:6379` by default, or `BLOT_REDIS_HOST`) - have one
running locally before benchmarking `img`.

## CI behaviour

### `benchmarks.yml` (the smoke-scale build + render benchmark)

GitHub-hosted runners are noisy, so nothing here blocks a merge — the signal
comes from trends, not single runs.

### On a pull request (once it's marked *ready for review*)

- runs on **amd64 only**, `2` iterations, aggregated to medians
  ([`aggregate.js`](aggregate.js))
- keeps **one** sticky comment ([`pr-comment.js`](pr-comment.js)) comparing the
  PR against the rolling master median. It has three states, all on the same
  comment:
  - **running** (`⏳` in the header) — flipped on as soon as the job starts, so
    the PR shows a run is in flight. The previous run's table stays visible.
  - **done** — the table, plus the commit it was benchmarked from (and the one
    before it) in the footer.
  - **run failed** — set if the job errors, so the comment never sticks on `⏳`.
- draft PRs are skipped entirely

### On push to master

- runs on **amd64 + arm64**, `3` iterations each
- appends the aggregated result to a per-arch rolling history
  ([`update-history.js`](update-history.js))
- if the **same metric regresses for the last 3 consecutive master commits**,
  opens a `benchmark-regression` issue ([`detect-regression.js`](detect-regression.js)).
  amd64 files issues; arm64 only logs until its noise profile is understood
  (flip by adding `--alert` to its matrix row).

### Manual

`workflow_dispatch` with `sites` / `files` / `iterations` inputs — uploads an
artifact, no comment, no issue.

### `benchmarks-corpus.yml` (build/cache the large corpus)

- `schedule` (weekly) + `workflow_dispatch` (with `sites`/`files` overrides
  for testing a smaller corpus on demand)
- builds the same `dev`-target Docker image as `benchmarks.yml` (same
  build-push-action + cache-from/cache-to block, kept verbatim for
  consistency)
- runs [`build-corpus.js`](build-corpus.js); saves the three artifacts +
  manifest to the `benchmark-corpus-v<CORPUS_SCHEMA_VERSION>-*` cache and a
  90-day `benchmark-corpus-artifacts` upload-artifact
- prints total artifact size to the workflow summary (target: low
  single-digit GB combined - the Actions cache cap is 10GB per repo, shared
  with every other cache)

### `benchmarks-render.yml` (render + burst phases against the cached corpus)

- triggers on PR/push to master touching `app/blog/**`, `app/models/**`,
  `app/templates/**`, `app/build/**`, `app/cdn/**`, `app/helper/**`, plus
  `workflow_dispatch`
- restores the newest `benchmark-corpus-v*` cache (falls back to
  [`seed-corpus.js`](seed-corpus.js) if missing entirely), loads the Redis
  dump into its job's `redis:6` service container, extracts `data/blogs`/
  `data/static`
- runs render + all six burst phases via `--corpus-mode render`
- its own sticky PR comment, its own `render-benchmarks-history-<arch>`
  cache, its own `render-benchmark-regression` issue label - not comparable
  to `benchmarks.yml`'s numbers, so kept entirely separate
- never writes back to the corpus cache - read-only consumer

### `benchmarks-converters.yml` (per-converter conversion timing)

- triggers on PR/push touching `app/build/converters/**` (or shared
  `app/build/*.js` / `app/build/metadata/**` / `app/build/math/
  normalizeLiteralDollars.js` / `app/build/prepare/titlify.js`, treated as
  affecting every converter), plus `workflow_dispatch`
- a `git diff` step figures out which converter(s) actually changed and only
  benchmarks those, via [`converter-bench.js`](converter-bench.js)
- runs directly on the standard runner (pandoc + libreoffice installed via
  `apt`, deps installed via `npm install` - no committed lockfile, so `npm ci`
  isn't an option) - no Docker, since a converter's `read()` only touches the
  filesystem, but a `redis:6` service container is still needed: the `img`
  converter's AVIF/WebP/HEIC fixtures go through `app/helper/transformer`,
  which is backed by the process-wide Redis client in `app/models/client`
- posts its own sticky PR comment and keeps a per-converter rolling history
  (`converter-benchmarks-history-*` cache) via
  [`converter-pr-comment.js`](converter-pr-comment.js) - see "Per-converter
  benchmarks" below

## Per-converter benchmarks

Unlike the render/build benchmark, this doesn't need a full Blog model or a
rebuilt static site - just a converter's own `read(blog, path, callback)`
function and its existing `app/build/converters/<name>/tests/**` fixtures.
[`converter-bench.js`](converter-bench.js) copies those fixtures into a
throwaway blog folder (a fake `{ id, imageExif, plugins }` object is enough -
every converter was grepped for direct `blog.*` field access to confirm nothing
else is read), times `--n` (default 300) conversions round-robin across them,
and reports p50/p95 wall time plus peak RSS - useful for memory-heavy
converters like image/docx. Most converters genuinely need nothing else, but
`img`'s AVIF/WebP/HEIC fixtures still go through the real
`app/helper/transformer` (backed by the shared Redis client), so
`benchmarks-converters.yml` runs a `redis:6` service container for every
converter, not just when `img` is in the changed set.

This intentionally has its own small metrics shape and its own simplified
regression check (latest vs. median-of-last-20, single threshold) rather than
reusing `lib/metrics.js`/`detect-regression.js`'s full apparatus, which is
sized for a dozen-metric render benchmark, not one timing number per
converter.

**Known limitation - peak RSS is per-process, not per-converter.** When
several converters run in the same `converter-bench.js` invocation (a
shared-dependency change triggers more than one, or a manual run selects
several), they run sequentially in one Node process and `peak_rss_mb` is the
absolute process RSS at that point - so a later converter's number includes
memory retained by earlier converters' modules/allocations, which can
misattribute a memory regression to the wrong converter. Not fixed (would
mean forking a child process per converter and reading its own RSS) since
this benchmark's primary signal is conversion timing, not memory; treat a
`peak_rss_mb` regression as "something in this job's process grew," not
necessarily "this specific converter grew."

## How results are stored

The rolling history is an append-only NDJSON file per arch
(`history-<arch>.ndjson`), one line per master commit. It is kept in the GitHub
Actions cache and mirrored to a 90-day `benchmark-history-<arch>` artifact.

If the cache misses (first run, or 7 days idle),
[`seed-history.js`](seed-history.js) restores the newest history artifact from a
successful master run. If that also fails, history just starts fresh — no
manual step required.

### Resetting / editing the baseline

The baseline is derived, not stored, so there are two ways to reset it:

**Automatic — bump `historySchemaVersion`.** Every history record carries the
`historySchemaVersion` from [`defaults.js`](spec/util/defaults.js)
at the time it was written. `computeBaseline` and `detect-regression.js` only
look at records whose `schema_version` matches the *current* value of that
constant — older records stay in the NDJSON file for reference but are
invisible to the baseline. Bump `historySchemaVersion` whenever a change
meaningfully redefines a tracked metric (new/removed metric, a workload shape
that shifts totals — e.g. this file's own `tags` / `tagBurstConcurrency`
addition bumped it 1 → 2, `archivesBurstConcurrency` bumped it 2 → 3, the
search/sitemap/backlinks burst additions bumped it 3 → 4, the not-found
burst addition plus the CPU/disk I/O metrics below bumped it 4 → 5, and
collapsing the six per-route burst p95/inflation pairs into a single
`render_burst_inflation_avg` metric bumped it 5 → 6, and dropping the build/
render p50 rows in favor of p95-only bumped it 6 → 7) and the next master run
starts a fresh baseline on its own, no manual cache-clearing required.

**Manual — clear the history.** For anything the schema-version bump doesn't
cover (e.g. you want to discard recent noisy runs without changing what's
measured):

1. delete the `benchmarks-history-amd64-*` / `-arm64-*` entries under the repo's
   Actions caches, and
2. delete the `benchmark-history-<arch>` artifacts (or let them age out).

Until `minBaselineSamples` (see defaults) master commits have accumulated *at
the current schema version*, the PR comment still shows deltas but marks them
information-only, and `detect-regression.js` will not open an issue.

## Interpreting the numbers

- **p50** is the stable one to watch; **p95** moves around more.
- A metric is flagged only when it is both outside the percentage band
  (`regressionThresholdPercent`, 15%; `sizeThresholdPercent`, 5% for byte sizes)
  **and** more than 3×MAD from the baseline median — so a big percentage swing on
  a tiny absolute number won't cry wolf.
- **Output size** is near-deterministic. A real move there almost always means a
  template / asset change and is worth a look even if timing is flat.
- One noisy PR run is expected. Sustained movement across master commits is not.

## File map

| File | Runs where | Purpose |
|------|-----------|---------|
| `index.js` | container | run the spec once, write result JSON |
| `spec/build-render.spec.js` | container | the Jasmine spec itself (build/render/burst phases, plus `--corpus-mode build/render` branches) |
| `spec/util/workload.js` | container | flat + skewed workload generation, media hard-link assignment |
| `spec/util/corpusSetup.js` | container | loads blogs from a corpus manifest instead of creating fresh ones (`--corpus-mode render`) |
| `spec/util/tagBurst.js` | container | tag-burst phase: solo vs. concurrent `/tagged/<slug>` timing |
| `spec/util/archivesBurst.js` | container | archives-burst phase: solo vs. concurrent `/archives` timing |
| `spec/util/searchBurst.js` | container | search-burst phase: solo vs. concurrent `/search?q=` timing |
| `spec/util/sitemapBurst.js` | container | sitemap-burst phase: solo vs. concurrent `/sitemap.xml` timing |
| `spec/util/backlinksBurst.js` | container | backlinks-burst phase: solo vs. concurrent hub-entry timing |
| `spec/util/notFoundBurst.js` | container | not-found-burst phase: solo vs. concurrent 404 timing |
| `lib/generate-media.js` | container | generates the shared media pool on the fly |
| `build-corpus.js` | host | orchestrates a one-time corpus build + snapshot (Part 4) |
| `seed-corpus.js` | host | restore the corpus from an artifact on cache miss |
| `converter-bench.js` | host (no Docker needed) | per-converter conversion timing |
| `converter-pr-comment.js` | host | sticky PR comment + rolling history for converter-bench.js |
| `invoke.sh` | host | run `index.js` in Docker + throwaway Redis |
| `compare.js` / `format-diff.js` | host | local branch-vs-branch comparison |
| `aggregate.js` | host | merge N iteration JSONs into one (median per metric) |
| `update-history.js` | host | append a master result, recompute baseline |
| `detect-regression.js` | host | open an issue on sustained master drift |
| `pr-comment.js` | host | post / update the PR comparison comment |
| `seed-history.js` | host | restore history from an artifact on cache miss |
| `lib/*.js` | host | shared stats / metric definitions / history / report |

## Ideas not yet built

- **Cold vs warm render split** — Blot caches rendered pages; first hit and
  repeat hit are different stories worth tracking separately.
- **CPU profile artifact** — attach a `--prof` / flamegraph of the render phase
  to regression issues so investigation starts with data.
- **Trend page** — publish `history-*.ndjson` as a small chart (Blot could
  literally host it as a blog), annotated with the PR that moved each metric.
- **Larger dedicated runner** — a fixed-size runner would cut variance enough to
  consider a soft gate; add it as another matrix row.
- **GC / event-loop-lag metrics** during the render phase.
- **Multi-tag / `sort=id` burst** — `fetchTaggedEntries.js` pulls a tag's
  whole entry-ID list and sorts it locally for `id`-sort and multi-tag
  intersection queries (`/tagged/a+b`), instead of paginating in Redis like
  the single-tag date-sort path does. Lower priority than the bursts already
  built here since it's bounded by a tag's size rather than the whole blog's
  entry count, but worth a burst if a customer's tags grow very large.
- **`benchmarks-corpus.yml`/`benchmarks-render.yml` end-to-end verification**
  — written and reviewed, but not exercised against real Docker/Redis/GitHub
  Actions in the environment this was built in. The `DEBUG RELOAD` Redis-dump
  restore trick and the corpus manifest → `corpusSetup.js` blog-loading path
  are the two spots most likely to need a tweak on first real run.
- **arm64 for the render/converter benchmarks** — both currently run amd64
  only, unlike `benchmarks.yml`'s amd64+arm64 master matrix.
