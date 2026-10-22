const clfdate = require("helper/clfdate");

// Retries a single Dropbox API call (e.g. list_folder) that failed with a
// transient 5xx or 429, so one blip doesn't abort a whole walk. Everything
// else (409 path errors, 401, network errors) is thrown straight away.
// For 429 the server's retry_after is honoured (as in waitForErrorTimeout).
//
// `delays` is the wait before each retry in ms; it is exported so specs can
// shorten it.
const retryRequest = async function (fn, label) {
  const delays = retryRequest.delays;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransient(err) || attempt >= delays.length) throw err;

      const wait = Math.max(delays[attempt], retryAfter(err) * 1000);
      console.log(
        clfdate() + " clients:dropbox:retryRequest",
        label || "",
        "status",
        err.status,
        "retrying in",
        wait,
        "ms"
      );
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
};

function isTransient(err) {
  const status = err && err.status;
  return status === 429 || (typeof status === "number" && status >= 500);
}

function retryAfter(err) {
  const body = err.error && err.error.error;
  const fromBody = body && body.retry_after;
  const header = err.headers && err.headers["retry-after"];
  const seconds = Number(fromBody || header);
  return seconds > 0 ? seconds : 0;
}

retryRequest.delays = [500, 1000, 2000, 4000, 8000];

module.exports = retryRequest;
