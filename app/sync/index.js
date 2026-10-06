const { inspect } = require("util");
const buildFromFolder = require("models/template").buildFromFolder;
const Blog = require("models/blog");
const Update = require("./update");
const localPath = require("helper/localPath");
const renames = require("./renames");
const folderLock = require("./lock");
const messenger = require("./messenger");
const gatherLockDiagnostics = require("./lock-diagnostics");
const clfdate = require("helper/clfdate");
const previewReload = require("helper/publishPreviewReload");
const {
  addPendingSync,
  removePendingSync,
  addPendingUpdate,
  removePendingUpdate
} = require("./lock-diagnostics-state");

const LOCK_STALE_TIMEOUT_MS = 10 * 1000;
const LOCK_UPDATE_INTERVAL_MS = 3 * 1000; // lowered from 5s to avoid ECOMPROMISED errors?
const PROCESS_STARTED = Date.now();

function sync(blogID, callback) {
  if (typeof blogID !== "string") {
    throw new TypeError("Expected blogID with type:String as first argument");
  }

  if (typeof callback !== "function") {
    throw new TypeError(
      "Expected callback with type:Function as second argument"
    );
  }

  Blog.get({ id: blogID }, async function (err, blog) {
    if (err || !blog || !blog.id || blog.isDisabled) {
      return callback(new Error("Cannot sync blog " + blogID));
    }

    const { log, status, syncID } = messenger(blog);

    log("Starting sync");

    let release;
    let lockAcquiredAt;

    try {
      log("Acquiring lock on folder");

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
        onCompromised: (err) => {
          // Another process may now own the lock, so the sync can no longer
          // be trusted to be exclusive. Log diagnostics, then crash the
          // process (as proper-lockfile's handler did) so it stops writing.
          gatherLockDiagnostics({ blogID, lockAcquiredAt, syncContext: { syncID } })
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
      release = lock.release;
      lockAcquiredAt = Date.now();
      addPendingSync(blogID, syncID);
      log("Successfully acquired lock on folder");
    } catch (e) {
      log("Failed to acquire lock on folder");
      return callback(new Error("Failed to acquire folder lock"));
    }

    // we want to know if folder.update or folder.rename is called
    let changes = false;
    let _update = new Update(blog, log, status);
    const originalUpdate = _update;
    _update = function (path, callback) {
      if (typeof callback !== "function") {
        return originalUpdate.apply(originalUpdate, arguments);
      }
      addPendingUpdate(blogID, syncID, path);
      let called = false;
      const wrappedCallback = function () {
        if (!called) {
          called = true;
          removePendingUpdate(blogID, syncID, path);
        }
        return callback.apply(this, arguments);
      };
      return originalUpdate.call(originalUpdate, path, wrappedCallback);
    };
    let path = localPath(blogID, "/");

    // Right now localPath returns a path with a trailing slash for some
    // crazy reason. This means that we need to remove the trailing
    // slash for this to work properly. In future, you should be able
    // to remove this line when localPath works properly.
    if (path.slice(-1) === "/") path = path.slice(0, -1);

    const folder = {
      path,
      update: function () {
        changes = true;
        _update.apply(_update, arguments);
      },
      status,
      log,
    };

    // We acquired a lock on the resource!
    // This function is to be called when we are finished
    // with the lock on the user's folder.
    folder.status("Syncing");

    // Pass methods to trigger folder updates back to the
    // function which wanted to modify the blog's folder.
    callback(null, folder, function (syncError, callback) {
      log("Sync callback invoked");
      removePendingSync(blogID, syncID);
      folder.status("Synced");

      if (typeof syncError === "function")
        throw new Error("Pass an error or null as first argument to done");

      if (typeof callback !== "function")
        throw new Error("Pass a callback to done");

      log("Checking for renamed files");
      renames(blogID, async function (err) {
        if (err) {
          folder.status("Error checking file renames");
          log("Error checking file renames");
          console.log(err);
        }

        log("Building templates from folder");
        buildFromFolder(blogID, async function (err) {
          if (err) {
            folder.status("Error building templates from folder");
            log("Error building templates in folder");
            console.log(err);
          }

          // We could do these next two things in parallel
          // but it's a little bit of refactoring...
          log("Releasing lock");
          try {
            await release();
          } catch (releaseError) {
            // Redis unreachable or the lock was already lost. Never leave
            // the caller's callback pending; surface the failure instead.
            log("Failed to release lock", releaseError.message);
            return callback(syncError || releaseError);
          }
          log("Finished sync");

          if (!changes) {
            return callback(syncError);
          }

          log("Updating cacheID of blog");
          Blog.set(blogID, { cacheID: Date.now() }, async function (err) {
            if (err) {
              log("Error updating cacheID of blog");
            }

            previewReload.publish(blogID);

            callback(syncError);
          });
        });
      });
    });
  });
}

module.exports = sync;
