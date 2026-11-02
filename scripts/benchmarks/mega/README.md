# Mega-site benchmark

A few blogs have renders slow enough to block the event loop for every other
blog on the same Node process. This benchmark generates sites with their
shape, serves them in-process next to some small sites, and times what hurts:
the base and head commits alternate in one job and the result is a sticky PR
comment. It only reports; it never fails.

## Running it

- On a branch: run the `benchmarks-mega` workflow from the Actions tab (or
  `gh workflow run benchmarks-mega.yml --ref <branch>`). It compares the
  branch with the merge base of its open pull request's base (or the `base`
  input, or master) and comments on that pull request if there is one, else
  writes the table to the run summary.
- On a pull request: add the `mega-benchmark` label.
- Locally, in the dev image against a throwaway Redis (it flushes nothing,
  but it writes about 110 MB):

  ```bash
  node --expose-gc --max-old-space-size=1800 scripts/benchmarks/mega/run.js \
    --output .benchmarks/mega/head-1.json [--scale 0.1]
  node scripts/benchmarks/mega/compare.js --dir .benchmarks/mega
  ```

  `--max-old-space-size=1800` is the heap production's node-a has.

## The sites

[`profile.js`](profile.js) holds the shapes, rounded; [`content.js`](content.js)
generates the entries from a fixed seed and writes them with `Entry.set`, so
no build runs and both sides get identical data.

- **catalog**: about 1,300 small entries and 380 tags, on a template
  ([`templates.js`](templates.js)) whose every page pulls the whole catalog
  unprojected (a head partial iterates `{{#archives}}` through a partial),
  every tag, two tags' entries, and a search index from `{{#allEntries}}`,
  with about 200 KB of inline CSS and JS. Six templates to preview.
- **heavy**: about 230 entries, a median of 120 KB of HTML each and a tail
  to 2.8 MB, on a fork of the stock Hypertext template with a page size of
  100. Hypertext's navigation lists `{{#posts}}` on every page, so a render
  after a cacheID bump reads 100 full entries for their titles, and
  `/archives` and `/sitemap.xml` read the whole catalog to print URLs.
- **small** ×4: 60 entries each on the default template, the other blogs.

## What it measures

Each run is a fresh process (cold caches) on an empty Redis:

| Phase | What |
|---|---|
| cold | first render of each site's heaviest pages (index, archives, sitemap, an entry, a tag page) |
| warm | the same pages five more times |
| after a bump | the same pages after a cacheID bump, as after any sync, three times |
| previews | `preview-of-my-<template>-on-<handle>` for each of the site's templates, three rounds; previews skip some render caches |
| other blogs | two visitors browse the small sites, first alone, then while the mega sites resync (cacheID bumps) and get browsed and previewed |
| memory | peak heap above the post-seed baseline, and what a GC leaves |

Timings are wall time of real HTTP requests; "block" is the longest event
loop delay while they ran (`monitorEventLoopDelay`). The render cache
counters (oversize fills, clone time, slowest fill) are read from
`blog/render`'s caches while the code still has them, and show as n/a once it
doesn't. Raw per-page timings and per-cache counters are in each run's JSON,
uploaded as the `mega-benchmark` artifact.

## Reading the comment

Medians of the runs, with their range. 🔺 marks a metric at least 15% worse
whose head runs all came out above every base run; 🟢 the reverse. Anything
unmarked is within noise, so a real change should show up as a marker in the
same direction on a rerun.
