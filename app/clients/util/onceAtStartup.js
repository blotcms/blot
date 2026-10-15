const lock = require("helper/lock");
const client = require("models/client");
const clfdate = require("helper/clfdate");

const FIFTEEN_MINUTES_IN_MS = 15 * 60 * 1000;

// Identifies the deploy this process belongs to. The deploy script passes the
// image commit hash as BLOT_RELEASE_ID (GIT_SHA is the fallback), the same
// value app/index.js uses for its start notification. Without either, fall
// back to a 15 minute bucket so processes starting together still agree.
function releaseId(now = Date.now()) {
  const id = process.env.BLOT_RELEASE_ID || process.env.GIT_SHA;
  if (id) return id;
  return "t" + Math.floor(now / FIFTEEN_MINUTES_IN_MS);
}

// Runs fn in one process per deploy, for startup one-offs that must not be
// repeated by every container. Resolves true if fn ran to completion here,
// false if it was skipped (done elsewhere, or someone else is running it and
// we gave up waiting). Rejects if fn does, or on Redis errors; callers decide
// what that means.
//
// What counts as "once" is a completed run, not a claim: fn runs under a lock
// and only a run that finishes sets the done marker. A process that crashes
// mid-work leaves no marker and its lock expires within the ttl, so a restart
// waits it out, takes the lock and runs the work again. The marker only needs
// to cover containers starting together during a deploy, so a crash-restart
// after it expires runs the work again too (e.g. Dropbox's resync of blogs
// that were syncing).
//
// fn must return a promise that settles when the work is done.
async function runOnceAtStartup(name, fn, options = {}) {
  const { doneTtl = FIFTEEN_MINUTES_IN_MS } = options;
  const prefix = "startup:" + name + ":" + releaseId();
  const doneKey = prefix + ":done";
  const done = async () => (await client.exists(doneKey)) > 0;

  if (await done()) return false;

  let held;
  try {
    // Retries add up to ~15s, longer than the ttl, so a crashed holder's lock
    // has expired by the last attempt.
    held = await lock(prefix + ":running", {
      ttl: 10000,
      heartbeat: 3000,
      retries: 4,
      minTimeout: 1000,
    });
  } catch (err) {
    if (err.code !== "ELOCKED" && err.code !== "ESLOW") throw err;
    if (await done()) return false;
    console.log(
      clfdate(),
      "[STARTUP]",
      name,
      "is running elsewhere, skipping on this boot"
    );
    return false;
  }

  try {
    // The previous holder may have finished just before we got the lock
    if (await done()) return false;
    await fn();
    await client.set(doneKey, "1", { PX: doneTtl });
    return true;
  } finally {
    try {
      await held.release();
    } catch (err) {
      console.error(clfdate(), "[STARTUP]", name, "release failed:", err.message);
    }
  }
}

module.exports = runOnceAtStartup;
module.exports.releaseId = releaseId;
