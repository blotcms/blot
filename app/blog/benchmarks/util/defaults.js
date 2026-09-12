"use strict";

/**
 * Single source of truth for benchmark knobs.
 *
 * Both the runner (scripts/benchmarks/index.js, runs on the host) and the spec
 * (app/blog/benchmarks/benchmarks.js, runs inside the container) read their
 * defaults from here so the two can never drift apart.
 */
const BENCHMARK_DEFAULTS = Object.freeze({
  // Number of blogs created for the run.
  sites: 5,
  // Total number of generated text entries, spread evenly across sites.
  files: 1000,
  // Deterministic seed for workload generation.
  seed: "blot-benchmark-seed",
  // Concurrency used when replaying sitemap URLs during the render phase.
  renderConcurrency: 8,
  // Concurrency used when writing the generated workload to disk.
  writeConcurrency: 32,
  // How often the phase monitor samples CPU / RSS.
  cpuSampleIntervalMs: 250,
  // Requests issued per sitemap URL per blog during the render phase.
  requestsPerPage: 1,
  // Number of distinct tags generated across each blog's entries. Modelled on
  // a real customer blog (~800 entries / ~40 tags) that suffered severe
  // event-loop-blocking slowdowns when several distinct /tagged/<slug> pages
  // were requested at the same time.
  tags: 40,
  // How many distinct /tagged/<slug> pages are requested in one genuinely
  // concurrent burst (Promise.all, not the pooled render-phase queue) during
  // the tag-burst phase, to catch request-queueing regressions.
  tagBurstConcurrency: 8,
  // How many /archives requests are fired in one genuinely concurrent burst.
  // Each blog has only one archives URL, so blogs repeat round-robin when
  // there are fewer sites than this — this reproduces cross-blog contention
  // (many customers' blogs sharing one Node process) as well as many tabs
  // hitting one big blog's /archives at once.
  archivesBurstConcurrency: 8,
  // Number of distinct search keywords spliced into ~35% of each blog's
  // entries, so full-text search (Entry.search, which scans candidates and
  // synchronously matches against each entry's full HTML per chunk) has
  // realistic, guaranteed-to-match terms to search for.
  searchKeywords: 15,
  // How many distinct /search?q=<keyword> pages are requested in one
  // genuinely concurrent burst, to catch regressions in Entry.search's
  // per-request, uncached full-text scan.
  searchBurstConcurrency: 8,
  // How many requests to a blog's single "hub" entry (linked to by ~25% of
  // its other entries, so it accumulates a realistic backlinks list) are
  // fired in one genuinely concurrent burst. Exercises augment.js's
  // per-backlink Entry.getByUrl fan-out (N Redis round trips per render)
  // under concurrent contention; blogs repeat round-robin when there are
  // fewer sites than this.
  backlinksBurstConcurrency: 8,
  // How many concurrent /sitemap.xml requests are fired across blogs (same
  // round-robin repeat rule as the archives burst). sitemap.xml iterates
  // {{#all_entries}} just like archives.js, but crawlers can and do fetch
  // several blogs' sitemaps around the same time.
  sitemapBurstConcurrency: 8,
  // CI gate / trend-alert threshold, in percent, applied to timing metrics.
  regressionThresholdPercent: 15,
  // Tight threshold for near-deterministic metrics (output byte size).
  sizeThresholdPercent: 5,
  // Baseline maturity gate: samples required before an alert can fire.
  minBaselineSamples: 8,
  // How many trailing master samples feed the robust baseline.
  baselineWindow: 20,
  // Consecutive master commits that must all regress before an issue opens.
  regressionConsecutive: 3,
  // Bump this whenever a change meaningfully redefines what a tracked metric
  // means (new/removed metric, changed workload shape that shifts totals,
  // etc). Records written under an older version are kept in history for
  // reference but excluded from the rolling baseline, so the next master run
  // starts a fresh baseline automatically instead of requiring someone to
  // manually clear the benchmarks-history-* Actions cache.
  historySchemaVersion: 5,
});

module.exports = { BENCHMARK_DEFAULTS };
