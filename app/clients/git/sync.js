var Sync = require("sync");
var withCallback = require("helper/withCallback");

// Brings the blog folder to master in the git store (served/sync.js), inside
// the sync's folder lock, and passes the changed paths to Blot. The commit
// Blot has applied is recorded in Redis (database.setApplied) once every path
// has been processed, and each sync diffs from it.
//
// gitHandle is the blog's handle at the time, kept for the callers: the store
// is keyed by blog ID, so the sync does not use it.
async function sync(blogID, gitHandle) {
  // if the blog ID is not a string, reject with an error
  if (typeof blogID !== "string") throw new Error("Blog ID must be a string");

  // if the git handle is not a non-empty string, reject with an error
  if (typeof gitHandle !== "string" || !gitHandle)
    throw new Error("Git handle must be a non-empty string");

  // Settles when the sync engine calls finish, after it has released the
  // folder lock
  await new Promise(function (resolve, reject) {
    function finish(err) {
      if (err) return reject(err);
      resolve();
    }

    // Attempt to acquire a lock on the blog's folder
    // to apply updates to it...
    Sync(blogID, function (err, folder, done) {
      // Typically, this error means were unable to acquire a lock
      // on the folder, perhaps another process is syncing it...
      if (err) return finish(err);

      require("./served/sync")(blogID, folder).then(
        function () {
          done(null, finish);
        },
        function (err) {
          folder.log(
            "Error updating blog folder from the store: " + err.message
          );
          done(err, finish);
        }
      );
    });
  });
}

module.exports = withCallback(sync);
