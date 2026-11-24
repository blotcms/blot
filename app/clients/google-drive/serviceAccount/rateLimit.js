// What the service account pollers (readChanges.js, searchEdits.js,
// pollRecentFolders.js) do when Drive refuses a call as rate limited: a 429,
// or a 403 whose reason is userRateLimitExceeded or rateLimitExceeded.
// gaxios doesn't retry a 403 (retryConfig.js), so each poller waits itself.
//
// Google's advice for these errors is exponential backoff with jitter. Each
// poller used to wait a fixed 10s, so a poller still refused after that came
// straight back, and the pollers of every service account a refusal hit at
// the same moment (three at once on 23 Nov 2026) came back together. Here the
// wait doubles with each refusal in a row, up to MAX_MS, and is a random
// time between half of it and all of it.
const BASE_MS = 10 * 1000;
const MAX_MS = 2 * 60 * 1000;

const RATE_LIMIT_REASONS = ["userRateLimitExceeded", "rateLimitExceeded"];

const statusOf = (err) =>
  Number(err?.code || err?.status || err?.response?.status) || null;

// The reason Drive gave, e.g. userRateLimitExceeded or insufficientPermissions
function reasonOf(err) {
  const errors = err?.errors || err?.response?.data?.error?.errors;
  return (Array.isArray(errors) && errors[0]?.reason) || null;
}

// A 403 with no reason is counted too: it is how a refusal looked before
// googleapis passed the reason on, and waiting costs a poller nothing
function isRateLimited(err) {
  const status = statusOf(err);
  if (status === 429) return true;
  if (status !== 403) return false;
  const reason = reasonOf(err);
  return !reason || RATE_LIMIT_REASONS.includes(reason);
}

// One per poller. next() is how long to wait after a refusal, reset() is
// called after a call that went through.
function backoff({ base = BASE_MS, max = MAX_MS, random = Math.random } = {}) {
  let refusals = 0;
  return {
    next() {
      const ms = Math.min(max, base * 2 ** refusals);
      refusals += 1;
      return Math.round(ms / 2 + (random() * ms) / 2);
    },
    reset() {
      refusals = 0;
    },
    get refusals() {
      return refusals;
    },
  };
}

module.exports = {
  isRateLimited,
  reasonOf,
  statusOf,
  backoff,
  BASE_MS,
  MAX_MS,
};
