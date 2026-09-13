"use strict";

const { performance } = require("perf_hooks");
const { summarizeDurations } = require("./metrics");
const { timedRequest } = require("./burstRequest");

/**
 * Each blog's workload includes one "hub" entry that a fraction of its other
 * entries link to (see hubPathBySite in workload.js), so it accumulates a
 * realistic backlinks list. Rendering an entry runs augment.js, which does
 * an async.map over entry.backlinks, issuing one Entry.getByUrl Redis
 * round trip per backlink - so rendering a heavily-backlinked entry fans out
 * into N lookups every time, uncached. This fires concurrent requests at
 * each blog's hub entry (repeating blogs round-robin when there are fewer
 * sites than the requested concurrency, like the archives/sitemap bursts)
 * to see whether that per-render fan-out serializes under concurrent load.
 */
async function runBacklinksBurst({ blogs, hubPathBySite, concurrency, getForBlog }) {
  const targets = [];
  for (let i = 0; i < concurrency && blogs.length; i++) {
    const blogIndex = i % blogs.length;
    const hubPath = hubPathBySite[blogIndex];
    if (hubPath) targets.push({ blog: blogs[blogIndex], hubPath });
  }

  if (!targets.length) {
    const empty = summarizeDurations([]);
    return {
      requests_tested_total: 0,
      solo_timing_ms: empty,
      burst_timing_ms: empty,
      inflation_ratio: null,
    };
  }

  const soloDurations = [];
  for (const { blog, hubPath } of targets) {
    const startedAt = performance.now();
    await timedRequest(getForBlog, blog, hubPath);
    soloDurations.push(performance.now() - startedAt);
  }

  const burstDurations = await Promise.all(
    targets.map(async ({ blog, hubPath }) => {
      const startedAt = performance.now();
      await timedRequest(getForBlog, blog, hubPath);
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

module.exports = { runBacklinksBurst };
