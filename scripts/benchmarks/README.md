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

The baseline is derived, not stored, so to reset it you clear the history:

1. delete the `benchmarks-history-amd64-*` / `-arm64-*` entries under the repo's
   Actions caches, and
2. delete the `benchmark-history-<arch>` artifacts (or let them age out).

Until `minBaselineSamples` (see defaults) master commits have accumulated, the
PR comment still shows deltas but marks them information-only, and
`detect-regression.js` will not open an issue.

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
