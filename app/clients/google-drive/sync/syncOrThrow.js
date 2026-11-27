const sync = require("clients/google-drive/sync");

// For a follow-up queue (clients/util/followUpSync): syncs the blog, and
// rejects if the sync didn't complete. sync() resolves false when it fails
// for any reason but the lock, rather than rejecting, and followUpSync counts
// anything that resolves as synced, so it would take back the follow-up of a
// change the sync never applied. Rejecting makes it retry the sync
// (FAILURE_RETRY_MS). The lock's own error passes through with rethrowLocked,
// as followUpSync needs it to.
module.exports = async function syncOrThrow(blogID, options = {}) {
  const result = await sync(blogID, { ...options, rethrowLocked: true });
  if (result === false) throw new Error("Google Drive sync did not complete");
  return result;
};
