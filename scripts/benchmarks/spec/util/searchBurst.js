"use strict";

const { performance } = require("perf_hooks");
const { summarizeDurations } = require("./metrics");
const { timedRequest } = require("./burstRequest");

/**
 * Same solo-vs-burst pattern as tagBurst.js, aimed at Entry.search
 * (app/models/entry/search.js): for each blog, pick up to `concurrency`
 * distinct search keywords (guaranteed to be present in some entries - see
 * buildSearchKeywordPool in workload.js), time each query solo, then fire
 * them all again with Promise.all. Entry.search scans the blog's entries in
 * chunks of 200 and, for each chunk, synchronously concatenates and
 * substring-matches against every candidate's *full HTML*, uncached and
 * redone from scratch on every request - a plausible real pattern (several
 * visitors searching a blog at once) as well as a structurally similar
 * risk to the tag/archives queueing bug.
 */
async function runSearchBurst({ blogs, keywordsBySite, concurrency, getForBlog }) {
  const soloDurations = [];
  const burstDurations = [];
  const perSite = [];

  for (let blogIndex = 0; blogIndex < blogs.length; blogIndex++) {
    const blog = blogs[blogIndex];
    const keywords = (keywordsBySite[blogIndex] || []).slice(0, concurrency);

    if (!keywords.length) {
      perSite.push({
        blog_id: blog.id,
        handle: blog.handle,
        keywords_tested: 0,
      });
      continue;
    }

    const urls = keywords.map(
      (keyword) => `/search?q=${encodeURIComponent(keyword)}`
    );

    // Uncontended baseline: one at a time, sequentially.
    const soloForSite = [];
    for (const url of urls) {
      const startedAt = performance.now();
      await timedRequest(getForBlog, blog, url);
      const elapsedMs = performance.now() - startedAt;
      soloForSite.push(elapsedMs);
      soloDurations.push(elapsedMs);
    }

    // Genuine concurrent burst: every distinct search query at once.
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
      keywords_tested: keywords.length,
      solo_mean_ms: soloMean,
      burst_mean_ms: burstMean,
      inflation_ratio: soloMean > 0 ? burstMean / soloMean : null,
    });
  }

  const soloTiming = summarizeDurations(soloDurations);
  const burstTiming = summarizeDurations(burstDurations);

  return {
    keywords_tested_total: perSite.reduce((sum, s) => sum + s.keywords_tested, 0),
    solo_timing_ms: soloTiming,
    burst_timing_ms: burstTiming,
    inflation_ratio:
      soloTiming.mean > 0 ? burstTiming.mean / soloTiming.mean : null,
    sites: perSite,
  };
}

module.exports = { runSearchBurst };
