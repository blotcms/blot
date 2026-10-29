const { AsyncLocalStorage } = require("async_hooks");
const folderLock = require("sync/lock");
const readOnly = require("helper/readOnly");
const clfdate = require("helper/clfdate");

// Template writes change files in the blog folder, so they take the same
// per-blog lock as a sync. Unlike a sync, which gives up after a few
// seconds, an editor save should wait its turn: syncs of a large folder can
// hold the lock for a while. lock() sleeps 0.5s, 1s, 2s... between attempts,
// so these retries wait roughly 31s in total before the save fails.
// Only the files are written under the lock; no renames or template build
// run afterwards, since the caller has already stored the template itself.
const LOCK_TTL_MS = 10 * 1000;
const LOCK_HEARTBEAT_MS = 3 * 1000;
const LOCK_RETRIES = 6;
const LOCK_MIN_TIMEOUT_MS = 500;

// An editor request that changes a locally edited template takes the lock
// before it changes anything (see holdForRequest), because a sync that holds
// the lock builds the template from the old folder files just before it
// releases, which would overwrite a view stored in the meantime. Writes made
// further down that request find the hold here instead of locking again.
const requestHold = new AsyncLocalStorage();

// Resolves to a release function. Waits out a read-only freeze first, and
// again if one began while the lock was being taken (as sync() does), so
// that a lock still held once the freeze is on belongs to an earlier writer.
async function acquire(blogID) {
  for (;;) {
    await readOnly.whenWritable("template write " + blogID);

    const lock = await folderLock.lock(blogID, {
      ttl: LOCK_TTL_MS,
      heartbeat: LOCK_HEARTBEAT_MS,
      retries: LOCK_RETRIES,
      minTimeout: LOCK_MIN_TIMEOUT_MS,
      onCompromised: function (err) {
        console.error(
          clfdate(),
          "[TEMPLATE]",
          blogID,
          "folder lock compromised during template write",
          err.message
        );
      },
    });

    // A failed check counts as writable, so it can never strand the lock
    if (await readOnly.status().catch(() => null)) {
      await lock.release();
      continue;
    }

    return lock.release;
  }
}

// Wraps fn(blogID, templateID, callback) so it runs while holding the lock,
// unless the current request already holds it.
function withFolderLock(fn) {
  return function (blogID, templateID, callback) {
    const hold = requestHold.getStore();

    if (hold && hold.blogID === blogID && !hold.released) {
      return fn(blogID, templateID, callback);
    }

    acquire(blogID).then(
      function (release) {
        fn(blogID, templateID, function () {
          const args = arguments;
          release().then(
            () => callback.apply(null, args),
            function (err) {
              console.error(
                clfdate(),
                "[TEMPLATE]",
                blogID,
                "failed to release folder lock",
                err.message
              );
              callback.apply(null, args);
            }
          );
        });
      },
      function (err) {
        callback(busyError(err));
      }
    );
  };
}

function busyError(err) {
  if (!err || err.code !== "ELOCKED") return err;
  const busy = new Error(
    "Your folder is busy syncing. Please try again in a moment."
  );
  busy.status = 423;
  return busy;
}

// Express middleware: take the blog's lock before the rest of the request
// runs, and hold it until the response is done. If the lock can't be had in
// time the request fails before anything has been changed.
function holdForRequest(req, res, next) {
  const blogID = req.blog.id;

  acquire(blogID).then(
    function (release) {
      const hold = { blogID, released: false };
      let done = false;

      function finish() {
        if (done) return;
        done = true;
        hold.released = true;
        release().catch(function (err) {
          console.error(
            clfdate(),
            "[TEMPLATE]",
            blogID,
            "failed to release folder lock",
            err.message
          );
        });
      }

      res.on("finish", finish);
      res.on("close", finish);
      requestHold.run(hold, next);
    },
    function (err) {
      next(busyError(err));
    }
  );
}

module.exports = withFolderLock;
module.exports.holdForRequest = holdForRequest;
