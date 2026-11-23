const config = require("config");
const MACSERVER_URL = config.icloud.server_address; // The Macserver base URL from config
const MACSERVER_AUTH = config.icloud.secret; // The Macserver Authorization secret from config
const database = require("../database");
const syncToiCloud = require("./toiCloud");
const syncFromiCloud = require("./fromiCloud");
const resolveCaseConflicts = require("../../util/resolveCaseConflicts");
const establishSyncLock = require("sync/establishSyncLock");
const fetch = require("../util/rateLimitedFetchWithRetriesAndTimeout");
const health = require("clients/health");

// The verify pass aborts on the first listing that fails (after
// remoteReaddir's own retries), so rerun it a couple of times with a
// pause before giving up: a stalled `ls` during the upload burst is
// usually gone a minute later.
const VERIFY_EXTRA_ATTEMPTS = 2;
const VERIFY_RETRY_DELAY_MS = 45 * 1000;

// /watch is the last step of a transfer that has already copied every file,
// so it waits out a macserver restart (2s, 4s, 8s, 16s between attempts)
// rather than failing the whole transfer on a blip. It stays fatal: it also
// lets the macserver act again for a blog disconnected earlier
// (reviveLimiterForBlogID in macserver/routes/watch.js).
const WATCH_RETRIES = 5;
const WATCH_RETRY_DELAY_MS = 2000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = async function initialTransfer(blogID, options = {}) {
  const verifyRetryDelayMs =
    options.verifyRetryDelayMs !== undefined
      ? options.verifyRetryDelayMs
      : VERIFY_RETRY_DELAY_MS;

  // Marked before the lock is taken: if taking it fails (another sync holds
  // it, or this process is draining for a deploy), the account still says a
  // transfer is due and resumeTransfers picks it up within the hour. The
  // macserver was already told "ok" and won't ask again.
  await database.store(blogID, { transferringToiCloud: true, error: null });

  const { folder, done } = await establishSyncLock(blogID);

  try {
    folder.status("Getting ready");
    await resolveCaseConflicts(blogID, folder.status, folder.update);

    // 'skipDeletions' sync does not remove
    // files from the iCloud folder if they do not exist on Blot.
    // this lets the user set up a folder which contains files and
    // which will be merged with the Blot folder.
    await syncToiCloud(blogID, folder.status, folder.update, {
      skipDeletions: true,
    });

    // we run the sync again to verify the transfer succeeded
    // it's important to abort on error here so we can surface the error to the user
    // and avoid data loss by continuing to sync down from iCloud
    for (let attempt = 0; ; attempt++) {
      try {
        await syncToiCloud(blogID, folder.status, folder.update, {
          skipDeletions: true,
          abortOnError: true,
          check: true,
        });
        break;
      } catch (error) {
        if (attempt >= VERIFY_EXTRA_ATTEMPTS) throw error;
        folder.status("Checking again in a minute");
        await sleep(verifyRetryDelayMs);
      }
    }

    // then run a sync from iCloud to pull down any files which
    // were added to the iCloud folder after the transfer.
    folder.status("Looking for files already in your folder");
    await syncFromiCloud(blogID, folder.status, folder.update);

    folder.status("Finishing up");

    // Now that the transfer is complete, notify the Macserver to begin watching the iCloud folder
    // for changes. This will let us know when the user has changed their folder on iCloud.
    await fetch(`${MACSERVER_URL}/watch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: MACSERVER_AUTH,
        blogID: blogID,
      },
      retries: WATCH_RETRIES,
      retryDelay:
        options.watchRetryDelayMs !== undefined
          ? options.watchRetryDelayMs
          : WATCH_RETRY_DELAY_MS,
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
      errorCode: health.CODES.TRANSFER_INCOMPLETE,
    });
    throw error;
  } finally {
    await done();
  }
};
