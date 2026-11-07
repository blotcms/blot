const promiseOnly = require("helper/promiseOnly");
const isRetryable = require("./classifyError").isRetryable;

// Wraps an async function so a failed call is tried again, up to
// options.times attempts in all, waiting options.interval(attempt) ms
// between them. The wrapped function returns a promise.
function retry(fn, options) {
  options = options || {};

  // Set our defaults
  options.times = options.times || 6;

  // Exponential backoff, from the second attempt on:
  // 200, 400, 800, 1600, 3200
  options.interval = options.interval || exponential;

  // Do not retry user-actionable failures (401 / invalid grant,
  // delta 409 folder missing, 507 quota) or ENAMETOOLONG. A 409
  // from a per-file op is also hopeless — restricted content and
  // path-not-found do not recover by waiting. Transient 429 / 5xx
  // / network errors still back off.
  //
  // ENAMETOOLONG = the destination path exceeds the filesystem's
  // max name/path length. Retrying can never succeed here since the
  // path length doesn't change between attempts – seen in production
  // when a Dropbox account got stuck repeatedly wrapping a file in
  // "(Conflict met exemplaar van ...)" copies, eventually producing a
  // filename over the OS limit. Without this, every sync attempt burned
  // through all 6 exponential-backoff retries before giving up.
  options.errorFilter =
    options.errorFilter ||
    function (err) {
      console.log("dropbox:retry invoked with err", err);
      return isRetryable(err);
    };

  return promiseOnly(async function (...args) {
    let attempt = 1;

    for (;;) {
      try {
        return await fn.apply(null, args);
      } catch (err) {
        // The filter is only consulted when another attempt is left
        if (attempt++ < options.times && options.errorFilter(err)) {
          await new Promise((resolve) =>
            setTimeout(resolve, options.interval(attempt))
          );
          continue;
        }

        throw err;
      }
    }
  });
}

// Exponential backoff
function exponential(retryCount) {
  return 50 * Math.pow(2, retryCount);
}

module.exports = retry;
