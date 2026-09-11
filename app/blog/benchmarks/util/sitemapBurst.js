"use strict";

const { performance } = require("perf_hooks");
const { summarizeDurations } = require("./metrics");
const { timedRequest } = require("./burstRequest");

/**
 * Same shape as archivesBurst.js, aimed at /sitemap.xml. Like /archives it
 * iterates {{#all_entries}} over the full entry set on every request (see
 * app/templates/source/blog/sitemap.xml), and like /archives there's only
 * one sitemap URL per blog, so bursting it means firing concurrently across
 * blogs (repeating round-robin when there are fewer sites than the
 * requested concurrency) rather than across distinct pages. Search engines
 * and other crawlers routinely fetch several blogs' sitemaps around the
 * same time, so this is a realistic concurrent-access pattern in its own
 * right, not just a duplicate of the archives burst's root cause.
 */
async function runSitemapBurst({ blogs, concurrency, getForBlog }) {
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

  const soloDurations = [];
  for (const blog of targets) {
    const startedAt = performance.now();
    await timedRequest(getForBlog, blog, "/sitemap.xml");
    soloDurations.push(performance.now() - startedAt);
  }

  const burstDurations = await Promise.all(
    targets.map(async (blog) => {
      const startedAt = performance.now();
      await timedRequest(getForBlog, blog, "/sitemap.xml");
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

module.exports = { runSitemapBurst };
