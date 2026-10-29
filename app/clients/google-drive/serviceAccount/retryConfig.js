const clfdate = require("helper/clfdate");

// gaxios retries Drive calls that fail with 429 or 5xx, but by default only 3
// times with ~100/500/1500ms delays, so on 21 Oct 2026 all four attempts of a
// folder lookup failed within ~2.5s of one Google blip. These delays (500, 500,
// 1500, 3500, 7500ms, capped at 8s) ride out a blip of ~13s, in the same spirit
// as the Dropbox client's retryRequest. Only idempotent methods are retried.
//
// gaxios (6.x) does not read Retry-After itself, so retryBackoff waits for the
// longer of its own delay and the header.
const retryAfterMs = (err) => {
  const headers = (err && err.response && err.response.headers) || {};
  const value = headers["retry-after"];
  const seconds = Number(value);
  if (seconds > 0) return seconds * 1000;
  const date = Date.parse(value);
  return date > Date.now() ? date - Date.now() : 0;
};

module.exports = {
  retry: 5,
  retryDelay: 500,
  retryDelayMultiplier: 2,
  maxRetryDelay: 8000,
  httpMethodsToRetry: ["GET", "HEAD", "OPTIONS", "PUT", "DELETE"],
  statusCodesToRetry: [[429, 429], [500, 599]],
  retryBackoff: (err, delay) => {
    const wait = Math.max(delay, retryAfterMs(err));
    return new Promise((resolve) => setTimeout(resolve, wait));
  },
  onRetryAttempt: (err) => {
    const config = err.config.retryConfig || {};
    console.log(
      clfdate() + " clients:google-drive:retry",
      err.config.url,
      "status",
      err.response && err.response.status,
      "attempt",
      config.currentRetryAttempt + "/" + config.retry
    );
  },
};
