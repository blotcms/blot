var Blog = require("models/blog");
var Sync = require("sync");
var promiseOnly = require("helper/promiseOnly");
var debug = require("debug")("blot:clients:local:disconnect");

// Removes the record which tells Blot that a given blog
// is synced from a local source folder. When the server
// starts, Blot will no longer watch that folder.
module.exports = promiseOnly(function disconnect(blogID) {
  debug("Blog", blogID, "Disconnecting local client");

  return new Promise(function (resolve, reject) {
    // Settles once the sync engine's done has released the lock and called
    // back.
    function callback(err) {
      if (err) return reject(err);
      resolve();
    }

    // Take the sync lock so we wait for a watcher sync that is still running.
    // Otherwise removing the blog deletes the lock's Redis key out from under
    // it, and that sync fails on release with ECOMPROMISED (which crashes
    // the process).
    Sync(blogID, function (err, folder, done) {
      if (err) return callback(err);

      folder.status("Disconnecting from local folder");

      // Nothing to repair on the way out: every change the client made went
      // through storage/folder, which the mirror follows. The source directory
      // is left where it is.
      Blog.set(blogID, { client: "" }).then(
        function () {
          done(null, callback);
        },
        function (err) {
          done(err, callback);
        }
      );
    });
  });
});
