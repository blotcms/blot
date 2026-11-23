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
const { setTimeout: wait } = require("timers/promises");

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

// Waits ms, or less if signal aborts first, then throws its reason
const sleep = async (ms, signal) => {
  await wait(ms, undefined, { signal }).catch(() => {});
  signal.throwIfAborted();
};

// A disconnect deletes the account. Writing to it after that would bring
// back a record of a blog that isn't connected (database.store creates one).
const isConnected = (account) => Boolean(account && account.sharingLink);

module.exports = async function initialTransfer(blogID, options = {}) {
  const verifyRetryDelayMs =
    options.verifyRetryDelayMs !== undefined
      ? options.verifyRetryDelayMs
      : VERIFY_RETRY_DELAY_MS;

  if (!isConnected(await database.get(blogID))) {
    throw new Error("Blog is not connected to iCloud: " + blogID);
  }

  // Marked before the lock is taken: if taking it fails (another sync holds
  // it, or this process is draining for a deploy), the account still says a
  // transfer is due and resumeTransfers picks it up within the hour. The
  // macserver was already told "ok" and won't ask again.
  await database.store(blogID, { transferringToiCloud: true, error: null });

  const { folder, done } = await establishSyncLock(blogID);
  const { signal } = folder;

  // A disconnect may have finished between the check above and the lock,
  // so the mark just stored may be all there is of the account. Stop
  // without copying anything. The mark is left: deleting it here could race
  // a new setup's first write, and resumeTransfers skips an account without
  // a sharing link.
  let connected;
  try {
    connected = isConnected(await database.get(blogID));
  } catch (error) {
    await done();
    throw error;
  }
  if (!connected) {
    await done();
    throw new Error("Blog is not connected to iCloud: " + blogID);
  }

  try {
    // Inside run, a write to the folder throws once a disconnect has
    // stopped the transfer (sync/seize.js)
    await folder.run(async () => {
      folder.status("Getting ready");
      await resolveCaseConflicts(blogID, folder.status, folder.update);

      // 'skipDeletions' sync does not remove
      // files from the iCloud folder if they do not exist on Blot.
      // this lets the user set up a folder which contains files and
      // which will be merged with the Blot folder.
      await syncToiCloud(blogID, folder.status, folder.update, {
        skipDeletions: true,
        signal,
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
            signal,
          });
          break;
        } catch (error) {
          if (signal.aborted || attempt >= VERIFY_EXTRA_ATTEMPTS) throw error;
          folder.status("Checking again in a minute");
          await sleep(verifyRetryDelayMs, signal);
        }
      }

      // then run a sync from iCloud to pull down any files which
      // were added to the iCloud folder after the transfer.
      folder.status("Looking for files already in your folder");
      await syncFromiCloud(blogID, folder.status, folder.update, { signal });

      // fromiCloud carries on past errors, an abort included
      signal.throwIfAborted();

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
        signal,
      });
      signal.throwIfAborted();
      folder.status("Setup complete");
      await database.store(blogID, {
        setupComplete: true,
        transferringToiCloud: false,
        error: null,
      });
    });
  } catch (error) {
    // Stopped for a disconnect, which has deleted the account (or is about
    // to): record nothing
    if (!signal.aborted) {
      await database.store(blogID, {
        transferringToiCloud: false,
        error: error?.message || String(error),
        errorCode: health.CODES.TRANSFER_INCOMPLETE,
      });
    }
    throw error;
  } finally {
    await done();
  }
};
