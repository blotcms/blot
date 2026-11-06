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
  but it writes about 110 MB and leaves it there):

  ```bash
  node --expose-gc --max-old-space-size=1800 scripts/benchmarks/mega/run.js \
    --output .benchmarks/mega/head-1.json [--scale 0.1]
  node scripts/benchmarks/mega/compare.js --dir .benchmarks/mega
  ```

  `--max-old-space-size=1800` is the heap production's node-a has.

## When to run it

Before merging anything that changes how a render reads or caches entries:
the render caches in `app/blog/render` (and their replacement in
`app/models`), `Entries.getAll` / `Entry.get`, field projection
(`projectEntryFields`, `hardenProjectedRetrieve`), `getFullView`, the
preview path, or what bumps a blog's `cacheID`. Run it twice: one run's
markers can be noise.

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

Each site models one way a real blog hurt everyone else on its process:

- **catalog** is cost per page. The catalog isn't big, but every page pulls
  all of it unprojected, plus every tag, and the owner keeps many templates,
  so template-editor previews (which skip the catalog caches) refill it on
  every request.
- **heavy** is entry size. Few entries, but enormous ones: each cacheID bump
  makes `posts` and `getAllCached` read and parse full entries just to print
  titles and URLs, and one `MGET` batch can carry tens of MB.

### Where the shapes came from

Read-only scans of production on 2 Nov 2026. The per-blog findings (which
blogs, their real sizes, what in each template triggers the cost, and a first
full-scale local run on master) are in `data/mega-shape/findings.md` in the
main checkout, gitignored with the raw `scan.json` and `templates.json`: the
repo is public, so blog names and real sizes stay out of it. To refresh the
profile, rerun an equivalent scan (a throwaway script from the scratchpad,
copied into a production container and run read-only as uid 1000, asking the
operator before every command; filter Redis keys by `TYPE` first), update
the findings there, and round the new shape into `profile.js`.

## What it measures

Each run is a fresh process (cold caches) on an empty Redis:

| Phase | What |
|---|---|
| cold | first render of each site's heaviest pages (index, archives, sitemap, an entry, a tag page) |
| warm | the same pages five more times |
| after a bump | the same pages after a cacheID bump, as after any sync, three times |
| previews | `preview-of-my-<template>-on-<handle>` for each of the site's templates, three rounds; previews skip some render caches |
| other blogs | two visitors browse the small sites, first alone for 4 s, then for 10 s while the mega sites resync (cacheID bumps) and get browsed and previewed, round after round; the window is fixed so a faster head samples the same span (each run's JSON has `megaRounds`, how many rounds it held) |
| memory | peak heap above the post-seed baseline, and what a GC leaves |

Timings are wall time of real HTTP requests; "block" is the longest event
loop delay while they ran (`monitorEventLoopDelay`). The render cache
counters (oversize fills, clone time, slowest fill) are read from
`blog/render`'s caches while the code still has them, and show as n/a once it
doesn't. Raw per-page timings and per-cache counters are in each run's JSON,
uploaded as the `mega-benchmark` artifact.

## Reading the comment

Medians of the runs, with their range. "worse" marks a metric at least 15% worse
whose head runs all came out above every base run; "better" the reverse. Anything
unmarked is within noise, so a real change should show up as a marker in the
same direction on a rerun.

## What it doesn't cover

- One Node process and one Redis client: it shows a mega site blocking other
  blogs' requests on its event loop, not a huge `MGET` stalling Redis for
  the other processes.
- Backlinks, search, builds and syncs, and the proxy cache in front of blogs
  (every request here reaches the renderer).
- Absolute numbers: a GitHub runner is slower and noisier than production.
  Compare base with head; use the findings above for scale.

To add a metric, set it on the `metrics` object in `run.js`, then add a row
to `METRICS` in [`compare.js`](compare.js) (every metric is lower-is-better).
