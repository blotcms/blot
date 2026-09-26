var async = require("async");
var isRetryable = require("./classifyError").isRetryable;

function retry(fn, options) {
  options = options || {};

  // Set our defaults
  options.times = options.times || 6;

  // Exponential backoff
  // 100, 200, 400, 800, 1600, 3200
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

  return function () {
    var args = Array.prototype.slice.call(arguments);
    var callback = args.pop();

    // Will timeout a single attempt, not the exported function
    if (options.timeout) fn = async.timeout(fn, options.timeout);

    async.retry(
      options,
      function (done) {
        fn.apply(null, args.concat(done));
      },
      callback
    );
  };
}

// Exponential backoff
function exponential(retryCount) {
  return 50 * Math.pow(2, retryCount);
}

module.exports = retry;
