const config = require("config");
const MACSERVER_URL = config.icloud.server_address; // The Macserver base URL from config
const MACSERVER_AUTH = config.icloud.secret; // The Macserver Authorization secret from config
const database = require("../database");
const syncToiCloud = require("./toiCloud");
const syncFromiCloud = require("./fromiCloud");
const resolveCaseConflicts = require("./resolveCaseConflicts");
const establishSyncLock = require("sync/establishSyncLock");
const fetch = require("../util/rateLimitedFetchWithRetriesAndTimeout");

module.exports = async function initialTransfer(blogID) {
  // establish sync lock
  const { folder, done } = await establishSyncLock(blogID);

  try {
    folder.status("Setting up iCloud sync");
    await database.store(blogID, { transferringToiCloud: true, error: null });
    folder.status("Resolving case conflicts");
    await resolveCaseConflicts(blogID, folder.status, folder.update);
    
    // 'skipDeletions' sync does not remove 
    // files from the iCloud folder if they do not exist on Blot.
    // this lets the user set up a folder which contains files and
    // which will be merged with the Blot folder.
    folder.status("Transferring files to iCloud");
    await syncToiCloud(blogID, folder.status, folder.update, { skipDeletions: true });

    // we run the sync again to verify the transfer succeeded
    // it's important to abort on error here so we can surface the error to the user
    // and avoid data loss by continuing to sync down from iCloud
    folder.status("Verifying transfer");
    await syncToiCloud(blogID, folder.status, folder.update, { skipDeletions: true, abortOnError: true });

    // then run a sync from iCloud to pull down any files which
    // were added to the iCloud folder after the transfer.
    folder.status("Syncing from iCloud");
    await syncFromiCloud(blogID, folder.status, folder.update);

    folder.status("Transfer complete");

    // Now that the transfer is complete, notify the Macserver to begin watching the iCloud folder
    // for changes. This will let us know when the user has changed their folder on iCloud.
    await fetch(`${MACSERVER_URL}/watch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: MACSERVER_AUTH,
        blogID: blogID,
      },
    });
    folder.status("Setup complete");
    await database.store(blogID, {
      setupComplete: true,
      transferringToiCloud: false,
      error: null,
    });
  } catch (error) {
    await database.store(blogID, {
      transferringToiCloud: false,
      error: error?.message || String(error),
      errorCode: "SYNC_ERROR",
    });
    throw error;
  } finally {
    await done();
  }
};
