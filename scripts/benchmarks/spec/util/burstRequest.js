"use strict";

/**
 * Fetch does not reject on a 4xx/5xx response, so every burst phase must
 * check the status itself - otherwise a routing or rendering failure specific
 * to that phase's URLs can make it look *faster* (an error page renders
 * quicker than the real one) while still producing a passing benchmark.
 * Also consumes the response body so an unread stream doesn't tie up a
 * connection across the dozens of requests each burst phase fires.
 *
 * Most bursts target real pages and just want "it succeeded" (any status
 * under 400). The not-found burst deliberately requests a page that doesn't
 * exist, so it passes `expectedStatus: 404` to assert the *specific* status
 * it's timing, rather than accepting whatever comes back - and
 * `expectedBodyIncludes` so a status code alone can't fool it: if the 404
 * middleware were ever bypassed (e.g. a bug that calls `next()` without
 * rendering), Express's own fallback 404 also returns status 404, but
 * without going through render/middleware.js's retrieve() at all - the very
 * thing this phase is timing. That would silently record a much faster,
 * cheaper response as if it were a real measurement.
 */
async function timedRequest(
  getForBlog,
  blog,
  url,
  { expectedStatus, expectedBodyIncludes } = {}
) {
  const res = await getForBlog(blog, url, { redirect: "manual" });
  const buffer = await res.arrayBuffer();

  const ok =
    expectedStatus !== undefined
      ? res.status === expectedStatus
      : res.status < 400;

  if (!ok) {
    throw new Error(
      `Burst request to ${url} on ${blog.handle} failed: status=${res.status}` +
        (expectedStatus !== undefined ? ` (expected ${expectedStatus})` : "")
    );
  }

  if (
    expectedBodyIncludes !== undefined &&
    !Buffer.from(buffer).toString("utf8").includes(expectedBodyIncludes)
  ) {
    throw new Error(
      `Burst request to ${url} on ${blog.handle} did not render the expected ` +
        `page: body is missing "${expectedBodyIncludes}"`
    );
  }

  return res;
}

module.exports = { timedRequest };
