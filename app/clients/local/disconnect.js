var Blog = require("models/blog");
var seize = require("sync/seize");
var debug = require("debug")("blot:clients:local:disconnect");

// Removes the record which tells Blot that a given blog
// is synced from a local source folder. When the server
// starts, Blot will no longer watch that folder.
module.exports = async function disconnect(blogID) {
  debug("Blog", blogID, "Disconnecting local client");

  // Under the sync lock, taken from a watcher sync still running
  // (sync/seize.js), which is stopped. Otherwise removing the blog deletes
  // the lock's Redis key out from under it, and that sync fails on release
  // with ECOMPROMISED (which crashes the process). A busy lock no longer
  // fails the disconnect, as Sync() did.
  await seize(
    blogID,
    async function () {
      // Nothing to repair on the way out: every change the client made went
      // through storage/folder, which the mirror follows. The source
      // directory is left where it is.
      await Blog.set(blogID, { client: "" });
    },
    { reason: "disconnect" }
  );
};
