const database = require("clients/icloud/database");

// Resolves if a walk may go on to its next step: throws once the blog is no
// longer connected, or once signal (the sync lock's, sync/seize.js) has
// aborted, e.g. for a disconnect.
module.exports = (blogID, signal) => {
  return async () => {
    if (signal) signal.throwIfAborted();
    const account = await database.get(blogID);
    if (!account) throw new Error("Blog not found");
  };
};
