"use strict";

/**
 * Fetch does not reject on a 4xx/5xx response, so every burst phase must
 * check the status itself - otherwise a routing or rendering failure specific
 * to that phase's URLs can make it look *faster* (an error page renders
 * quicker than the real one) while still producing a passing benchmark.
 * Also consumes the response body so an unread stream doesn't tie up a
 * connection across the dozens of requests each burst phase fires.
 */
async function timedRequest(getForBlog, blog, url) {
  const res = await getForBlog(blog, url, { redirect: "manual" });
  await res.arrayBuffer();

  if (res.status >= 400) {
    throw new Error(
      `Burst request to ${url} on ${blog.handle} failed: status=${res.status}`
    );
  }

  return res;
}

module.exports = { timedRequest };
