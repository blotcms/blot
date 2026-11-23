const { inspect } = require("util");
const folderLock = require("./lock");
const gatherLockDiagnostics = require("./lock-diagnostics");
const clfdate = require("helper/clfdate");
const readOnly = require("helper/readOnly");
const guard = require("storage/folder/guard");

// Taking and holding a blog's sync lock (./lock.js), shared by sync() and by
// scripts which must not race a sync but are not one: hold(blogID, fn) runs
// fn with the lock held and nothing else. No status messages, no renames,
// templates or CDN manifests, and no check that the blog is enabled.

const LOCK_STALE_TIMEOUT_MS = 10 * 1000;
const LOCK_UPDATE_INTERVAL_MS = 3 * 1000; // lowered from 5s to avoid ECOMPROMISED errors?
const PROCESS_STARTED = Date.now();

// The error a seized holder's signal aborts with: code ECANCELED, and the
// reason seize() gave, e.g. "disconnect"
function cancelError(blogID, reason) {
  const err = new Error("Sync cancelled for " + reason + ": " + blogID);
  err.code = "ECANCELED";
  err.reason = reason;
  return err;
}

// Takes the blog's lock, retrying briefly. Resolves to the lock
// ({ release, signal }), or to null if the data directory became read-only
// meanwhile, in which case the lock has been released again and the caller
// should wait and retry. Rejects if the lock is held.
//
// signal aborts when seize() (./seize.js) wants the lock: the holder should
// stop and release it. Writes to the folder from inside hold() and sync()
// then throw (storage/folder/guard.js). If the lock is lost while seize()
// wants it or has just taken it by force, the signal aborts too. If it is
// lost otherwise, the process crashes (see onCompromised), so nothing keeps
// writing without it.
//   syncID        for the diagnostics logged if the lock is lost
//   acquiredAt    a function returning when the caller considers it acquired
//   retries       { retries, minTimeout } in place of the defaults below
//   ignoreCancel  for seize() itself
async function take(blogID, options = {}) {
  const { syncID, acquiredAt = () => undefined, ignoreCancel } = options;
  const controller = new AbortController();

  // Only retry at startup to handle stale locks from killed processes
  const timeSinceStart = Date.now() - PROCESS_STARTED;
  const retries =
    options.retries ||
    (timeSinceStart < LOCK_STALE_TIMEOUT_MS
      ? { retries: 1, minTimeout: LOCK_STALE_TIMEOUT_MS + 1000 } // 11s total
      : { retries: 3, minTimeout: 750 }); // 0.75s, 1.5s, 3s = 5.25s total

  const lock = await folderLock.lock(blogID, {
    ttl: LOCK_STALE_TIMEOUT_MS,
    heartbeat: LOCK_UPDATE_INTERVAL_MS,
    ...retries,
    ignoreCancel,
    onCancel: (reason) => {
      console.log(clfdate(), "[LOCK] cancelled for", reason, blogID);
      controller.abort(cancelError(blogID, reason));
    },
    onCompromised: async (err) => {
      // seize() took the lock: this holder was told to stop, or was too busy
      // to hear, so stop it without taking the process's other syncs down
      if (await folderLock.wasSeized(blogID)) {
        console.log(clfdate(), "[LOCK] seized", blogID, err.message);
        if (!controller.signal.aborted)
          controller.abort(cancelError(blogID, "seize"));
        return;
      }

      // Another process may now own the lock, so the holder can no longer
      // be trusted to be exclusive. Log diagnostics, then crash the
      // process (as proper-lockfile's handler did) so it stops writing.
      gatherLockDiagnostics({
        blogID,
        lockAcquiredAt: acquiredAt(),
        syncContext: { syncID },
      })
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
                  heartbeat: LOCK_UPDATE_INTERVAL_MS,
                },
                diagnostics,
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
    },
  });

  // The freeze may have begun between the caller's wait and taking the
  // lock. Back off, so that once the freeze is on, any lock still held
  // belongs to something that started before it. A failed check counts as
  // writable, so it can never strand the lock.
  if (await readOnly.status().catch(() => null)) {
    await lock.release();
    return null;
  }

  // A seized holder's release finds the lock gone: it fails with the
  // reason it was cancelled, not as a lost lock
  const release = lock.release;
  lock.release = async function () {
    try {
      await release();
    } catch (err) {
      if (err.code === "ECOMPROMISED" && (await folderLock.wasSeized(blogID))) {
        throw controller.signal.reason || cancelError(blogID, "seize");
      }
      throw err;
    }
  };

  lock.signal = controller.signal;
  return lock;
}

// Runs async fn({ signal }) while holding the blog's sync lock and resolves
// to what it resolves to. Waits while the data directory is read-only, as
// sync() does. The lock is released whether fn resolves or rejects. Rejects
// with code "ELOCKED" if the lock is held by something else (after a few
// seconds of retries), or with the lock's own error code if taking it failed
// otherwise. signal is the lock's (see take). options go to take.
async function hold(blogID, fn, options = {}) {
  if (typeof blogID !== "string") {
    throw new TypeError("Expected blogID with type:String as first argument");
  }

  let lock = null;

  while (!lock) {
    await readOnly.whenWritable("hold " + blogID);

    try {
      lock = await take(blogID, options);
    } catch (err) {
      const failure = new Error(
        "Failed to acquire folder lock for " + blogID + ": " + err.message
      );
      failure.code = err.code || "ELOCKED";
      throw failure;
    }
  }

  const { signal } = lock;

  try {
    return await guard.run(blogID, signal, () => fn({ signal }));
  } finally {
    await lock.release();
  }
}

module.exports = hold;
module.exports.take = take;
module.exports.cancelError = cancelError;
