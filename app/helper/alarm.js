const crypto = require("crypto");
const client = require("models/client");
const clfdate = require("helper/clfdate");
const { isRedisUnavailableError } = require("helper/redisUnavailable");

// Alarms held in Redis that any process can claim: an alarm is set for a
// time, can be reset or cancelled, and fires in whichever of any number of
// processes claims it (at least once - see below). It replaces per-process
// in-memory timers, which had to be rebuilt at boot and only ran in one
// container.
//
//   const alarms = alarm("scheduled-entries", async (id) => {...});
//   await alarms.set(id, when);  // replaces any existing alarm for id
//   alarms.start();              // poll for due alarms every pollMs
//
// Each name is one sorted set, alarm:due:<name>: member = id, score = due time
// in ms, plus a hash alarm:claims:<name>: id -> token of the current claim.
// The kind comes first so no two names can ever share a key.
// There is no payload; the handler re-reads state when it fires.
//
// Delivery is at-least-once, so handlers must be idempotent. A poll claims
// one due id at a time, moving its score to now + leaseMs and storing a
// fresh random token, so each id's lease starts when its handling begins.
// While the handler runs the lease is renewed every renewMs. If the handler
// throws, or the process dies, renewal stops and the id becomes due again
// once the lease runs out, to be retried by whichever process polls next.
// Completion, like renewal, only applies while the id still holds our token.
// set and cancel drop the token, so an alarm set again during handling (a
// post rescheduled while it was publishing) keeps its new time, and one
// cancelled during handling stays gone.
//
// set and cancel are a plain MULTI. Only claim, renew and complete use Lua,
// because each compares before it writes and Redis 6.2 can't do that natively.

// The three steps that compare before they write need to be atomic, and
// Redis 6.2 has no compare-and-set, so each is a short Lua script.
const CLAIM = `
local due = redis.call("ZRANGEBYSCORE", KEYS[1], "-inf", ARGV[1], "LIMIT", 0, 1)
if #due == 0 then return false end
redis.call("ZADD", KEYS[1], tonumber(ARGV[1]) + tonumber(ARGV[2]), due[1])
redis.call("HSET", KEYS[2], due[1], ARGV[3])
return due[1]`;

const RENEW = `
if redis.call("HGET", KEYS[2], ARGV[1]) == ARGV[2] then
  redis.call("ZADD", KEYS[1], ARGV[3], ARGV[1])
  return 1
end
return 0`;

const COMPLETE = `
if redis.call("HGET", KEYS[2], ARGV[1]) == ARGV[2] then
  redis.call("ZREM", KEYS[1], ARGV[1])
  redis.call("HDEL", KEYS[2], ARGV[1])
  return 1
end
return 0`;

function toMs(when) {
  const ms = when instanceof Date ? when.getTime() : when;
  if (typeof ms !== "number" || !Number.isFinite(ms)) {
    throw new TypeError("alarm: when must be a Date or a finite ms timestamp");
  }
  return ms;
}

function requireString(value, label) {
  if (typeof value !== "string" || !value) {
    throw new TypeError("alarm: " + label + " must be a non-empty string");
  }
  return value;
}

module.exports = function alarm(name, handler, options = {}) {
  requireString(name, "name");
  if (typeof handler !== "function") {
    throw new TypeError("alarm: handler must be a function");
  }

  const {
    pollMs = 5000,
    leaseMs = 60000,
    renewMs = Math.max(1, Math.floor(leaseMs / 3)),
    batch = 10,
    now = () => Date.now(),
  } = options;

  if (!Number.isInteger(leaseMs) || leaseMs < 2) {
    throw new TypeError("alarm: leaseMs must be an integer of at least 2");
  }
  for (const [label, value] of [
    ["pollMs", pollMs],
    ["renewMs", renewMs],
    ["batch", batch],
  ]) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new TypeError("alarm: " + label + " must be a positive number");
    }
  }
  if (!Number.isInteger(batch)) {
    throw new TypeError("alarm: batch must be an integer");
  }
  if (renewMs >= leaseMs) {
    throw new TypeError("alarm: renewMs must be less than leaseMs");
  }

  const key = "alarm:due:" + name;
  const claimsKey = "alarm:claims:" + name;
  let timer = null;
  let inFlight = null;
  let stopping = false;

  function log(message, err) {
    console.log(clfdate(), "[alarm]", name, message, err ? err.message : "");
  }

  async function set(id, when) {
    requireString(id, "id");
    await client
      .multi()
      .zAdd(key, { score: toMs(when), value: id })
      .hDel(claimsKey, id)
      .exec();
  }

  async function cancel(id) {
    requireString(id, "id");
    await client.multi().zRem(key, id).hDel(claimsKey, id).exec();
  }

  async function when(id) {
    requireString(id, "id");
    const score = await client.zScore(key, id);
    return score === null || score === undefined ? null : Number(score);
  }

  // Runs the handler for a claimed id, renewing its lease until it settles
  async function handle(id, token) {
    let renewing = true;
    let renewal = null;

    const renew = setInterval(() => {
      if (!renewing || renewal) return;
      renewal = client
        .eval(RENEW, {
          keys: [key, claimsKey],
          arguments: [id, token, String(now() + leaseMs)],
        })
        .then((renewed) => {
          // Set again, cancelled or claimed elsewhere: no longer ours
          if (Number(renewed) !== 1) renewing = false;
        })
        .catch((err) => log("could not renew " + id + ":", err))
        .then(() => {
          renewal = null;
        });
    }, renewMs);
    renew.unref();

    try {
      await handler(id);
    } finally {
      renewing = false;
      clearInterval(renew);
      if (renewal) await renewal;
    }
  }

  async function run() {
    let handled = 0;

    for (let i = 0; i < batch && !stopping; i++) {
      const token = crypto.randomUUID();
      let id;
      // Real clock, not the now option: it measures how long the reply took
      const sentAt = Date.now();

      try {
        id = await client.eval(CLAIM, {
          keys: [key, claimsKey],
          arguments: [String(now()), String(leaseMs), token],
        });
      } catch (err) {
        log(isRedisUnavailableError(err) ? "Redis unavailable:" : "claim failed:", err);
        break;
      }

      if (!id) break;

      // stop() was called while the claim was in flight: start nothing new.
      // The lease runs out and the id is claimed again later.
      if (stopping) break;

      // The lease started when Redis ran the claim. If the reply took so long
      // that the first renewal could no longer land before it runs out, another
      // process may already own this id, so don't run it: the lease expires
      // and it is claimed again later.
      if (Date.now() - sentAt >= leaseMs - renewMs) {
        log("claim reply too late for " + id);
        continue;
      }

      try {
        await handle(id, token);
      } catch (err) {
        // Left in place: it becomes due again when the lease expires
        log("handler failed for " + id + ":", err);
        continue;
      }

      handled++;

      try {
        await client.eval(COMPLETE, {
          keys: [key, claimsKey],
          arguments: [id, token],
        });
      } catch (err) {
        // The handler ran, so it will run again after the lease
        log("could not clear " + id + ":", err);
      }
    }

    return handled;
  }

  // Resolves to the number of ids handled successfully. Calls made while a
  // poll is running share that poll rather than starting another.
  function poll() {
    if (inFlight) return inFlight;
    inFlight = run().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      poll().catch((err) => log("poll failed:", err));
    }, pollMs);
    timer.unref();
  }

  // Waits for the handler underway, but claims nothing more in its batch
  async function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    if (!inFlight) return;
    stopping = true;
    try {
      await inFlight.catch(() => {});
    } finally {
      stopping = false;
    }
  }

  return { set, cancel, when, start, stop, poll };
};
