# Blot benchmarks

Reproducible build + render benchmarks for a Blot blog, plus the CI plumbing
that turns them into a PR comment and a master-branch regression watch.

## What it measures

One run creates `--sites` blogs, writes `--files` generated text entries plus a
fixed set of converter fixtures (markdown, docx, rtf, odt, org, images, gdoc —
reused from `app/build/converters/*/tests`), then:

| Phase      | What happens                                                    | Headline metrics |
|------------|----------------------------------------------------------------|------------------|
| **build**  | write the workload to disk, then `blog.rebuild()` every site   | per-site wall time p50 / p95, peak RSS, CPU % |
| **render** | fetch every URL in each blog's sitemap and read the full body  | per-page wall time p50 / p95, peak RSS, CPU %, output bytes/page |
| **tag burst** | for each site, request several distinct `/tagged/<slug>` pages once solo (uncontended) and once as a genuine concurrent burst | burst p50/p95, burst ÷ solo inflation ratio |
| **archives burst** | request `/archives` (repeating blogs round-robin if there are fewer sites than the concurrency) once solo per target and once as a genuine concurrent burst | burst p50/p95, burst ÷ solo inflation ratio |
| **search burst** | for each site, request several distinct `/search?q=<keyword>` queries once solo and once as a genuine concurrent burst | burst p50/p95, burst ÷ solo inflation ratio |
| **sitemap burst** | request `/sitemap.xml` (same round-robin rule as archives) once solo per target and once as a genuine concurrent burst | burst p50/p95, burst ÷ solo inflation ratio |
| **backlinks burst** | request each site's "hub" entry — linked to by ~25% of its other entries — (same round-robin rule) once solo and once as a genuine concurrent burst | burst p50/p95, burst ÷ solo inflation ratio |

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

Everything is seeded (`--seed`, default `blot-benchmark-seed`) so the generated
workload is identical from run to run. The full result is written as JSON; the
tracked-metric list lives in [`lib/metrics.js`](lib/metrics.js).

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
[`app/blog/benchmarks/util/defaults.js`](../../app/blog/benchmarks/util/defaults.js).

## CI behaviour

`.github/workflows/benchmarks.yml`. GitHub-hosted runners are noisy, so nothing
here blocks a merge — the signal comes from trends, not single runs.

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
`historySchemaVersion` from [`defaults.js`](../../app/blog/benchmarks/util/defaults.js)
at the time it was written. `computeBaseline` and `detect-regression.js` only
look at records whose `schema_version` matches the *current* value of that
constant — older records stay in the NDJSON file for reference but are
invisible to the baseline. Bump `historySchemaVersion` whenever a change
meaningfully redefines a tracked metric (new/removed metric, a workload shape
that shifts totals — e.g. this file's own `tags` / `tagBurstConcurrency`
addition bumped it 1 → 2, `archivesBurstConcurrency` bumped it 2 → 3, and the
search/sitemap/backlinks burst additions bumped it 3 → 4) and the next master
run starts a fresh baseline on its own, no manual cache-clearing required.

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
| `app/blog/benchmarks/benchmarks.js` | container | the Jasmine spec itself |
| `app/blog/benchmarks/util/tagBurst.js` | container | tag-burst phase: solo vs. concurrent `/tagged/<slug>` timing |
| `app/blog/benchmarks/util/archivesBurst.js` | container | archives-burst phase: solo vs. concurrent `/archives` timing |
| `app/blog/benchmarks/util/searchBurst.js` | container | search-burst phase: solo vs. concurrent `/search?q=` timing |
| `app/blog/benchmarks/util/sitemapBurst.js` | container | sitemap-burst phase: solo vs. concurrent `/sitemap.xml` timing |
| `app/blog/benchmarks/util/backlinksBurst.js` | container | backlinks-burst phase: solo vs. concurrent hub-entry timing |
| `invoke.sh` | host | run `index.js` in Docker + throwaway Redis |
| `compare.js` / `format-diff.js` | host | local branch-vs-branch comparison |
| `aggregate.js` | host | merge N iteration JSONs into one (median per metric) |
| `update-history.js` | host | append a master result, recompute baseline |
| `detect-regression.js` | host | open an issue on sustained master drift |
| `pr-comment.js` | host | post / update the PR comparison comment |
| `seed-history.js` | host | restore history from an artifact on cache miss |
| `lib/*.js` | host | shared stats / metric definitions / history / report |

## Ideas not yet built

- **Per-converter build timing** — attribute build time to markdown vs docx vs
  image conversion so a regression points straight at the culprit.
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
