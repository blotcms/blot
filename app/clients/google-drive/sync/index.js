const clfdate = require("helper/clfdate");
const establishSyncLock = require("sync/establishSyncLock");
const database = require("../database");

module.exports = async function (blogID) {

  const sync = require("./sync.js");

  try {
    const account = await database.blog.get(blogID);
    if (!account?.folderId) {
      return;
    }

    const { done, folder } = await establishSyncLock(blogID);
    try {
      // Resolves to sync's summary, or false if the walk failed.
      return await sync(blogID, folder.status, folder.update);
    } catch (err) {
      console.log(clfdate(), "Google Drive Sync:", "Sync failed", err);
      return false;
    } finally {
      // It's important to always release the lock
      await done();
    }
  } catch (err) {
    console.log(clfdate(), "Google Drive Sync:", "Sync init failed", err);
    return false;
  }
};
