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

    // When the blog last had a real sync (webhook, poll or hot doc), for the
    // hourly validation to decide which blogs to check (see ../validate.js).
    // Stamped on the attempt, before the lock, like Dropbox's last_sync. The
    // lock's own "Synced" statuses can't be used for this: the validation
    // takes the lock too.
    await database.blog
      .store(blogID, { lastSync: Date.now() })
      .catch((err) =>
        console.log(clfdate(), "Google Drive Sync:", "Error stamping lastSync", err)
      );

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
