"use strict";

const { performance } = require("perf_hooks");
const { summarizeDurations } = require("./metrics");
const { timedRequest } = require("./burstRequest");

// Set verbatim by app/blog/routes/error.js's 404 middleware as
// `res.locals.error.message` and interpolated into every template's
// error.html as `{{error.message}}` - present in the rendered body
// regardless of which of the ~20 templates a benchmark blog uses, so it's a
// stable, template-independent marker that the real 404 render path ran.
const NOT_FOUND_BODY_MARKER = "There is no page with this URL.";

/**
 * Same solo-vs-burst pattern as the other bursts, aimed at the 404 path
 * instead of a real page. Every request targets a path guaranteed not to
 * exist (the workload only ever writes paths under `/benchmark-<n>-...`), so
 * this exercises app/blog/routes/error.js's final catch-all middleware: like
 * /archives and /search it runs render/middleware.js's retrieve() fresh and
 * synchronously on every request (only the compiled error.html template
 * itself is cached, not the rendered output), and it also fires an
 * unawaited store404() Redis write (app/models/404/set.js) to log the miss
 * for the dashboard. Error routes are real production traffic too - dead
 * links, scanners and mistyped URLs all land here - and a benchmark suite
 * that only ever requests 2xx pages would miss a regression specific to
 * that path.
 */
async function runNotFoundBurst({ blogs, concurrency, getForBlog }) {
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
    const blog = blogs[i % blogs.length];
    targets.push({ blog, path: `/benchmark-404-not-found-${i}` });
  }

  // Uncontended baseline: one at a time, sequentially.
  const soloDurations = [];
  for (const { blog, path } of targets) {
    const startedAt = performance.now();
    await timedRequest(getForBlog, blog, path, {
      expectedStatus: 404,
      expectedBodyIncludes: NOT_FOUND_BODY_MARKER,
    });
    soloDurations.push(performance.now() - startedAt);
  }

  // Genuine concurrent burst: every target's 404 page requested at once.
  const burstDurations = await Promise.all(
    targets.map(async ({ blog, path }) => {
      const startedAt = performance.now();
      await timedRequest(getForBlog, blog, path, {
        expectedStatus: 404,
        expectedBodyIncludes: NOT_FOUND_BODY_MARKER,
      });
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

module.exports = { runNotFoundBurst };
