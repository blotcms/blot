var set = require("./set");
var clfdate = require("helper/clfdate");
var { isRedisUnavailableError } = require("helper/redisUnavailable");

// Render caches are keyed on the blog's cacheID and never expire, so a bump
// rejected because Redis is unavailable (or frozen for a host cutover) would
// leave the site serving stale pages until something else bumps it. Retry
// those in the background for about a minute. The promise settles after the
// first attempt, rejecting with its error, so callers aren't held open;
// onRetried fires if a later attempt succeeds. Any other error is not retried.
var RETRY_MS = 5 * 1000;
var RETRY_FOR_MS = 60 * 1000;

module.exports = async function bumpCacheID(blogID, onRetried) {
  var startedAt = Date.now();

  try {
    await set(blogID, { cacheID: Date.now() });
  } catch (err) {
    if (err && isRedisUnavailableError(err)) retry(err);
    throw err;
  }

  function retry(err) {
    var givingUp = Date.now() - startedAt >= RETRY_FOR_MS;

    console.error(
      clfdate(),
      "Blog:",
      blogID + ":",
      givingUp
        ? "Could not update cacheID, giving up"
        : "Could not update cacheID, will retry",
      err.message
    );

    if (givingUp) return;

    var timeout = setTimeout(async function () {
      try {
        await set(blogID, { cacheID: Date.now() });
      } catch (err) {
        if (err && isRedisUnavailableError(err)) {
          retry(err);
        } else {
          console.error(
            clfdate(),
            "Blog:",
            blogID + ":",
            "Could not update cacheID",
            err.message
          );
        }
        return;
      }

      console.log(clfdate(), "Blog:", blogID + ":", "Updated cacheID");
      if (onRetried) onRetried();
    }, RETRY_MS);

    if (typeof timeout.unref === "function") timeout.unref();
  }
};
