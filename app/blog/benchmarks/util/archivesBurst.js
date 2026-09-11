"use strict";

const { performance } = require("perf_hooks");
const { summarizeDurations } = require("./metrics");
const { timedRequest } = require("./burstRequest");

/**
 * Each blog has exactly one /archives URL, so "bursting" it can't mean many
 * distinct URLs the way the tag burst does. Instead this reproduces the same
 * request-queueing failure mode from the other direction: many customer
 * blogs sharing one Node process land on their (each equally expensive,
 * uncached) /archives page at the same moment. When there are fewer blogs
 * than the requested concurrency, blogs repeat round-robin, so this also
 * covers the "many tabs hit one big blog's /archives at once" case with
 * `--sites 1`.
 *
 * Like archives.js itself, this pulls the full entry set via
 * Entries.getAll and does a synchronous year/month grouping pass with
 * per-entry moment.tz formatting on every request (see
 * app/blog/render/retrieve/archives.js) - no caching, so concurrent hits
 * should queue behind each other's synchronous work exactly like the tag
 * burst does.
 */
async function runArchivesBurst({ blogs, concurrency, getForBlog }) {
  if (!blogs.length) {
    const empty = summarizeDurations([]);
    return {
      requests_tested_total: 0,
      solo_timing_ms: empty,
      burst_timing_ms: empty,
      inflation_ratio: null,
    };
  }

  const targets = [];
  for (let i = 0; i < concurrency; i++) {
    targets.push(blogs[i % blogs.length]);
  }

  // Uncontended baseline: one at a time, sequentially.
  const soloDurations = [];
  for (const blog of targets) {
    const startedAt = performance.now();
    await timedRequest(getForBlog, blog, "/archives");
    soloDurations.push(performance.now() - startedAt);
  }

  // Genuine concurrent burst: every target blog's /archives at once.
  const burstDurations = await Promise.all(
    targets.map(async (blog) => {
      const startedAt = performance.now();
      await timedRequest(getForBlog, blog, "/archives");
      return performance.now() - startedAt;
    })
  );

  const soloTiming = summarizeDurations(soloDurations);
  const burstTiming = summarizeDurations(burstDurations);

  return {
    requests_tested_total: targets.length,
    solo_timing_ms: soloTiming,
    burst_timing_ms: burstTiming,
    inflation_ratio:
      soloTiming.mean > 0 ? burstTiming.mean / soloTiming.mean : null,
  };
}

module.exports = { runArchivesBurst };
