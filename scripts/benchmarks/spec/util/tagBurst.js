"use strict";

const { performance } = require("perf_hooks");
const { summarizeDurations } = require("./metrics");
const { timedRequest } = require("./burstRequest");

/**
 * Reproduces the queueing bug found on a real customer blog: individual
 * requests to different /tagged/<slug> pages were each fast in isolation,
 * but requesting several distinct tag pages at the same time made every one
 * of them queue behind the others' synchronous, uncached, per-request work
 * over the full entry set (see app/blog/render/load/augment.js and
 * app/blog/render/locals.js).
 *
 * For each blog: pick up to `concurrency` distinct tags, time each one
 * in isolation (uncontended baseline), then fire all of them at once with
 * Promise.all (a genuine concurrent burst, unlike the render phase's pooled
 * queue) and time that too. The ratio between the two is a direct signal for
 * this class of regression — it should stay close to 1 on a healthy render
 * path and blow up when requests are serializing behind blocking work.
 */
async function runTagBurst({ blogs, tagsBySite, concurrency, getForBlog }) {
  const soloDurations = [];
  const burstDurations = [];
  const perSite = [];

  for (let blogIndex = 0; blogIndex < blogs.length; blogIndex++) {
    const blog = blogs[blogIndex];
    const tags = (tagsBySite[blogIndex] || []).slice(0, concurrency);

    if (!tags.length) {
      perSite.push({
        blog_id: blog.id,
        handle: blog.handle,
        tags_tested: 0,
      });
      continue;
    }

    const urls = tags.map((tag) => `/tagged/${encodeURIComponent(tag)}`);

    // Uncontended baseline: one at a time, sequentially.
    const soloForSite = [];
    for (const url of urls) {
      const startedAt = performance.now();
      await timedRequest(getForBlog, blog, url);
      const elapsedMs = performance.now() - startedAt;
      soloForSite.push(elapsedMs);
      soloDurations.push(elapsedMs);
    }

    // Genuine concurrent burst: every distinct tag page requested at once.
    const burstForSite = await Promise.all(
      urls.map(async (url) => {
        const startedAt = performance.now();
        await timedRequest(getForBlog, blog, url);
        return performance.now() - startedAt;
      })
    );

    burstForSite.forEach((elapsedMs) => burstDurations.push(elapsedMs));

    const soloMean =
      soloForSite.reduce((sum, ms) => sum + ms, 0) / soloForSite.length;
    const burstMean =
      burstForSite.reduce((sum, ms) => sum + ms, 0) / burstForSite.length;

    perSite.push({
      blog_id: blog.id,
      handle: blog.handle,
      tags_tested: tags.length,
      solo_mean_ms: soloMean,
      burst_mean_ms: burstMean,
      inflation_ratio: soloMean > 0 ? burstMean / soloMean : null,
    });
  }

  const soloTiming = summarizeDurations(soloDurations);
  const burstTiming = summarizeDurations(burstDurations);

  return {
    tags_tested_total: perSite.reduce((sum, s) => sum + s.tags_tested, 0),
    solo_timing_ms: soloTiming,
    burst_timing_ms: burstTiming,
    inflation_ratio:
      soloTiming.mean > 0 ? burstTiming.mean / soloTiming.mean : null,
    sites: perSite,
  };
}

module.exports = { runTagBurst };
