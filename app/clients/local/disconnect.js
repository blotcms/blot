var Blog = require("models/blog");
var Sync = require("sync");
var debug = require("debug")("blot:clients:local:disconnect");

// Removes the record which tells Blot that a given blog
// is synced from a local source folder. When the server
// starts, Blot will no longer watch that folder.
module.exports = function disconnect(blogID, callback) {
  debug("Blog", blogID, "Disconnecting local client");

  // Take the sync lock so we wait for a watcher sync that is still running.
  // Otherwise removing the blog deletes the lock's Redis key out from under
  // it, and that sync fails on release with ECOMPROMISED (which crashes
  // the process).
  Sync(blogID, function (err, folder, done) {
    if (err) return callback(err);

    folder.status("Disconnecting from local folder");

    // The watcher changed the folder on disk without going through
    // storage/folder, so S3's copy may be behind: it must be repaired before
    // the blog, no longer on the Local client, could be served from S3
    require("storage/folder/mirror")
      .markBehind(blogID)
      .catch(function () {})
      .then(function () {
        setClient();
      });

    function setClient() {
      Blog.set(blogID, { client: "" }, function (err) {
        done(err, callback);
      });
    }
  });
};
