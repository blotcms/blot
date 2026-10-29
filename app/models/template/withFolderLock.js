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

// Wraps fn(blogID, templateID, callback) so it runs while holding the lock.
// Callers must not already hold the lock for this blog: it is not reentrant.
module.exports = function withFolderLock(fn) {
  return function (blogID, templateID, callback) {
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
        callback(err);
      }
    );
  };
};

async function acquire(blogID) {
  // As for syncs: wait out a read-only freeze before taking the lock
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

  return lock.release;
}
