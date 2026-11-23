const database = require("clients/google-drive/database");

// signal: the sync lock's folder.signal. Once a disconnect has aborted it
// (sync/seize.js), the walk stops at its next step.
module.exports = (blogID, initialAccount, signal) => {
  return async () => {
    if (signal) signal.throwIfAborted();
    const account = await database.blog.get(blogID);
    if (!account) throw new Error("Blog not found");
    if (account.folderId !== initialAccount.folderId)
      throw new Error("Folder ID changed");
    if (!account.serviceAccountId)
      throw new Error("Service account ID not found");
    if (account.preparing !== initialAccount.preparing)
      throw new Error("Preparing has changed");
  };
};
