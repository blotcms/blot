const client = require("models/client");
const clfdate = require("helper/clfdate");
const { isRedisUnavailableError } = require("helper/redisUnavailable");

// A maintainer-set freeze on writes to blogs, for maintenance
// that needs writes to stop for a few minutes (a host cycle's switch, for
// example: config/host/cycle.sh). Turn it on and off with
// scripts/read-only.js. While it is on:
//
// - state-changing requests to the dashboard and the clients get a 503 with
//   Retry-After (rejectWrites below), which the sync clients already treat as
//   "try again later", and the dashboard shows a "Sync paused" health issue
// - sync() waits before taking a folder lock (whenWritable), so background
//   syncs pause rather than fail, and resume once the freeze lifts
//
// The key always carries a TTL, so a freeze whose maintainer went away (a
// crashed script, a closed laptop) lifts on its own. If Redis is unreachable
// the freeze counts as off: every write needs Redis anyway, and the
// redis-unavailable handling already turns those requests away.
//
// Every dashboard page and write checks it, so status() is one plain GET,
// which the client-side cache serves locally (the "readonly" class in
// models/redis-cache): setting, removing or expiring the key pushes an
// invalidation to every process. The value carries its own expiry time, so
// status() needs no TTL call and ignores a value whose expiry push is late.

const KEY = "blot:read-only";
const DEFAULT_TTL_SECONDS = 15 * 60;
const RETRY_AFTER_SECONDS = 30;
const POLL_INTERVAL_MS = 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Resolves to null when writes are allowed, otherwise to
// { reason, since, expiresInSeconds }
async function status() {
  let value;

  try {
    value = await client.get(KEY);
  } catch (err) {
    if (isRedisUnavailableError(err)) return null;
    throw err;
  }

  if (value === null || value === undefined) return null;

  let parsed = {};
  try {
    parsed = JSON.parse(value) || {};
  } catch (e) {}

  // A value written before expiresAt was stored has no expiry to report
  const expiresAt = Number(parsed.expiresAt) || null;
  if (expiresAt && expiresAt <= Date.now()) return null;

  return {
    reason: typeof parsed.reason === "string" ? parsed.reason : "",
    since: Number(parsed.since) || null,
    expiresInSeconds: expiresAt
      ? Math.ceil((expiresAt - Date.now()) / 1000)
      : null,
  };
}

// Turns the freeze on, or extends it, for ttl seconds. Extending keeps the
// original start time so status() reports how long writes have been frozen.
async function enable({ reason = "", ttl = DEFAULT_TTL_SECONDS } = {}) {
  if (!Number.isInteger(ttl) || ttl < 1) {
    throw new TypeError("ttl must be a positive whole number of seconds");
  }

  const current = await status();
  const since = (current && current.since) || Date.now();

  const expiresAt = Date.now() + ttl * 1000;

  await client.set(KEY, JSON.stringify({ reason, since, expiresAt }), {
    EX: ttl,
  });
}

async function disable() {
  await client.del(KEY);
}

// Resolves once writes are allowed. Callers must not hold a folder lock while
// they wait, so the freeze can drain.
async function whenWritable(label) {
  let logged = false;

  while (await status()) {
    if (!logged) {
      console.log(clfdate(), "[READ ONLY] waiting to write:", label || "-");
      logged = true;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  if (logged) console.log(clfdate(), "[READ ONLY] resuming:", label || "-");
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Express middleware that answers 503 to any request that could write while
// the freeze is on. `allow` lists functions of req for unsafe requests that
// only touch Redis (logging in) or only read (a git fetch's POST); `deny`
// lists safe requests to refuse anyway (the GET that starts a git push).
function rejectWrites({ allow = [], deny = [] } = {}) {
  return async function (req, res, next) {
    const denied = deny.some((isDenied) => isDenied(req));
    if (!denied && SAFE_METHODS.has(req.method)) return next();
    if (!denied && allow.some((isAllowed) => isAllowed(req))) return next();

    let frozen;
    try {
      frozen = await status();
    } catch (err) {
      return next(err);
    }

    if (!frozen) return next();

    res.status(503);
    res.set({
      "Retry-After": String(RETRY_AFTER_SECONDS),
      "Cache-Control": "no-store",
    });
    res
      .type("text")
      .send(
        "Blot is briefly read-only for maintenance. Please try again in a few minutes."
      );
  };
}

module.exports = {
  KEY,
  DEFAULT_TTL_SECONDS,
  RETRY_AFTER_SECONDS,
  status,
  enable,
  disable,
  whenWritable,
  rejectWrites,
};
