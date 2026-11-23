const client = require("models/client");
const clfdate = require("helper/clfdate");
const readOnly = require("helper/readOnly");
const guard = require("storage/folder/guard");
const folderLock = require("./lock");
const { take } = require("./hold");

// seize(blogID, fn, { reason, wait }) runs async fn({ signal }) holding the
// blog's folder lock, taking it from whatever holds it, and resolves to what
// fn resolves to. For a disconnect, which must win over a running sync:
//
// 1. It sets the lock's cancel key to reason. The holder's heartbeat reads
//    it within a few seconds and aborts its signal, so the sync stops at its
//    next check and releases the lock, and its writes to the folder throw
//    meanwhile (storage/folder/guard.js). Nothing else can take the lock
//    while the key is set.
// 2. If the lock is still held after wait ms, the holder ignored the signal
//    or was too busy to hear it. seize takes the lock by force, leaving a
//    marker so the holder stops quietly when it finds its lock gone instead
//    of crashing its process (see hold.js). Each "[LOCK] forced seize" line
//    is a path that doesn't check the signal.
//
// A second seize of the same blog meanwhile (a double click) waits for the
// first to finish rather than forcing it, and gives up with code ELOCKED
// after MAX_WAIT_MS.

const POLL_MS = 500;
const MAX_WAIT_MS = 5 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function seize(blogID, fn, options = {}) {
  if (typeof blogID !== "string") {
    throw new TypeError("Expected blogID with type:String as first argument");
  }

  const { reason = "disconnect", wait = 20 * 1000 } = options;
  const cancelKey = folderLock.cancelKey(blogID);

  // Whether this seize set the cancel key, and so may force the lock
  async function claim() {
    const set = await client.set(cancelKey, reason, {
      NX: true,
      PX: wait + 2 * 60 * 1000,
    });
    return set === "OK";
  }

  const startedAt = Date.now();
  let owner = await claim();
  let deadline = Date.now() + wait;
  let forcedAt = null;
  let lock = null;

  try {
    while (!lock) {
      await readOnly.whenWritable("seize " + blogID);

      try {
        // Resolves to null if the data directory became read-only
        lock = await take(blogID, {
          ignoreCancel: true,
          retries: { retries: 0 },
        });
        if (lock) break;
        continue;
      } catch (err) {
        if (err.code !== "ELOCKED") throw err;
      }

      if (!owner && (owner = await claim())) deadline = Date.now() + wait;

      const now = Date.now();

      if (owner && now >= deadline && forcedAt === null) {
        const [holder, since] = await Promise.all([
          folderLock.inspect(blogID).catch(() => ({})),
          folderLock.heldSince(blogID).catch(() => null),
        ]);
        console.error(
          clfdate(),
          "[LOCK] forced seize",
          blogID,
          `reason=${reason}`,
          `waited=${now - startedAt}ms`,
          `heldFor=${since ? now - since + "ms" : "unknown"}`,
          `holder=${holder.holder || "none"}`
        );
        forcedAt = now;
        await folderLock.forceRelease(blogID);
        continue;
      }

      // Even after forcing, a sync could take the lock between the delete
      // and our take, then back off on seeing the cancel key
      if (
        (forcedAt !== null && now - forcedAt > wait) ||
        now - startedAt > MAX_WAIT_MS
      ) {
        const err = new Error("Could not seize folder lock for " + blogID);
        err.code = "ELOCKED";
        throw err;
      }

      await sleep(POLL_MS);
    }

    const { signal } = lock;

    try {
      return await guard.run(blogID, signal, () => fn({ signal }));
    } finally {
      await lock.release();
    }
  } finally {
    if (owner) await client.del(cancelKey).catch(() => {});
  }
}

module.exports = seize;
