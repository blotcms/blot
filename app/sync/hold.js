const { inspect } = require("util");
const folderLock = require("./lock");
const gatherLockDiagnostics = require("./lock-diagnostics");
const clfdate = require("helper/clfdate");
const readOnly = require("helper/readOnly");

// Taking and holding a blog's sync lock (./lock.js), shared by sync() and by
// scripts which must not race a sync but are not one: hold(blogID, fn) runs
// fn with the lock held and nothing else. No status messages, no renames,
// templates or CDN manifests, and no check that the blog is enabled.

const LOCK_STALE_TIMEOUT_MS = 10 * 1000;
const LOCK_UPDATE_INTERVAL_MS = 3 * 1000; // lowered from 5s to avoid ECOMPROMISED errors?
// A sync which reports no progress (folder.status or folder.update) for this
// long is treated as hung: the lock stops being renewed and the sync is failed
// as if the lock were lost (see onCompromised). Every client reports per file,
// so only a step stuck on one network call or file is this quiet. Tests lower
// it through take's noProgressTimeout option or module.exports.defaults.
const defaults = { noProgressTimeout: 30 * 60 * 1000 };
const PROCESS_STARTED = Date.now();

// Takes the blog's lock, retrying briefly. Resolves to the lock ({ release }),
// or to null if the data directory became read-only meanwhile, in which case
// the lock has been released again and the caller should wait and retry.
// Rejects if the lock is held. If the lock is later lost, the process
// crashes (see onCompromised), so nothing keeps writing without it.
//   syncID      for the diagnostics logged if the lock is lost
//   acquiredAt  a function returning when the caller considers it acquired
//   noProgressTimeout  ms of silence (no lock.touch()) after which the lock is
//               treated as compromised; off unless given, so hold() is unaffected
async function take(blogID, options = {}) {
  const { syncID, acquiredAt = () => undefined, noProgressTimeout } = options;

  // Only retry at startup to handle stale locks from killed processes
  const timeSinceStart = Date.now() - PROCESS_STARTED;
  const retries =
    timeSinceStart < LOCK_STALE_TIMEOUT_MS
      ? { retries: 1, minTimeout: LOCK_STALE_TIMEOUT_MS + 1000 } // 11s total
      : { retries: 3, minTimeout: 750 }; // 0.75s, 1.5s, 3s = 5.25s total

  const lock = await folderLock.lock(blogID, {
    ttl: LOCK_STALE_TIMEOUT_MS,
    heartbeat: LOCK_UPDATE_INTERVAL_MS,
    ...retries,
    noProgressTimeout,
    onCompromised: (err) => {
      // Another process may now own the lock, so the holder can no longer
      // be trusted to be exclusive. Log diagnostics, then crash the
      // process (as proper-lockfile's handler did) so it stops writing.
      gatherLockDiagnostics({ blogID, lockAcquiredAt: acquiredAt(), syncContext: { syncID } })
        .catch((diagErr) => ({ diagnosticsError: String(diagErr) }))
        .then((diagnostics) => {
          // console.error's default util.inspect depth (2) was silently
          // flattening diagnostics.pendingSyncs/pendingUpdates to
          // "[Object]" - exactly the detail needed to tell whether some
          // other blog's sync was starving this heartbeat. depth: null
          // prints it in full.
          console.error(
            clfdate(),
            "[LOCK COMPROMISED]",
            inspect(
              {
                blogID,
                error: { message: err.message, code: err.code },
                lockConfig: {
                  ttl: LOCK_STALE_TIMEOUT_MS,
                  heartbeat: LOCK_UPDATE_INTERVAL_MS
                },
                diagnostics
              },
              { depth: null, maxArrayLength: null }
            )
          );
        })
        .finally(() => {
          setImmediate(() => {
            throw err;
          });
        });
    }
  });

  // The freeze may have begun between the caller's wait and taking the
  // lock. Back off, so that once the freeze is on, any lock still held
  // belongs to something that started before it. A failed check counts as
  // writable, so it can never strand the lock.
  if (await readOnly.status().catch(() => null)) {
    await lock.release();
    return null;
  }

  return lock;
}

// Runs async fn() while holding the blog's sync lock and resolves to what it
// resolves to. Waits while the data directory is read-only, as sync() does.
// The lock is released whether fn resolves or rejects. Rejects with code
// "ELOCKED" if the lock is held by something else (after a few seconds of
// retries), or with the lock's own error code if taking it failed otherwise.
async function hold(blogID, fn) {
  if (typeof blogID !== "string") {
    throw new TypeError("Expected blogID with type:String as first argument");
  }

  let lock = null;

  while (!lock) {
    await readOnly.whenWritable("hold " + blogID);

    try {
      lock = await take(blogID);
    } catch (err) {
      const failure = new Error("Failed to acquire folder lock for " + blogID + ": " + err.message);
      failure.code = err.code || "ELOCKED";
      throw failure;
    }
  }

  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

module.exports = hold;
module.exports.take = take;
module.exports.defaults = defaults;
