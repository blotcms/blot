const database = require("../../database");
const initialTransfer = require("../../sync/initialTransfer");
const syncFromiCloud = require("../../sync/fromiCloud");
const establishSyncLock = require("sync/establishSyncLock");
const { handleSyncLockError } = require("../lock");
const email = require("helper/email");
const notificationCap = require("../../util/notificationCap");

const RESYNC_DEDUP_WINDOW_MS = 10 * 1000;
// Process-local resync deduplication: if multiple Node processes handle requests,
// this in-memory guard will not deduplicate across processes.
const resyncDedupRegistry = new Map();

// The macserver can request a resync every few seconds while a user is
// moving folders around, so cap the admin email to one per blog per hour.
// The resync itself still runs every time. Per-process, like the guard above.
const notifyResyncRequested = notificationCap({
  max: 1,
  resetAfterMs: 60 * 60 * 1000,
});

module.exports = async function (req, res) {

  const blogID = req.header("blogID");
  const status = req.body;

  const handle = (label, err) => {
    console.error(label, err);
    if (!res.headersSent) {
      res.status(500).send("Internal Server Error");
    }
  }

  if (!blogID || !status) {
    return res.status(400).send("Missing blogID or status");
  }

  try {
    // store the status in the database
    await database.store(blogID, status);

  } catch (err) {
    return handle("Failed to store status in database", err);
  }

  if (status.resyncRequested) {
    const now = Date.now();
    const existingEntry = resyncDedupRegistry.get(blogID);
    if (existingEntry) {
      const isCooldown = existingEntry.cooldownUntil > now;
      if (existingEntry.inFlight || isCooldown) {
        console.log("Resync request deduplicated", {
          blogID,
          inFlight: existingEntry.inFlight,
          cooldownUntil: existingEntry.cooldownUntil,
        });
        return res.send("ok");
      }
      resyncDedupRegistry.delete(blogID);
    }

    const dedupEntry = {
      inFlight: true,
      cooldownUntil: now + RESYNC_DEDUP_WINDOW_MS,
      cleanupTimeout: null,
    };
    resyncDedupRegistry.set(blogID, dedupEntry);

    try {
      // This will throw if the sync lock is already established
      const { done, folder } = await establishSyncLock(blogID);

      // Now that we have the sync lock, we can send "ok" to the
      // macserver since the resync can take a while
      res.send("ok");

      try {
        folder.status("Resync requested");
        console.log("Resync requested from iCloud", { blogID });
        const result = notifyResyncRequested(blogID, () =>
          email.ICLOUD_RESYNC_REQUESTED(null, { blogID })
        );
        if (result === "suppressed") {
          console.log("Resync email suppressed", { blogID });
        }

        // Since we treat the iCloud folder as the source of truth,
        // there is the risk that files added to Blot's folder (e.g. preview files)
        // or template files which were edited online will be clobbered. 
        // in in future, we might be able to implement a system to merge
        // but for now we'll just sync down from iCloud.
        await syncFromiCloud(blogID, folder.status.bind(folder), folder.update);
        folder.status("Resync complete");
      } finally {
        dedupEntry.inFlight = false;
        dedupEntry.cooldownUntil = Date.now() + RESYNC_DEDUP_WINDOW_MS;
        if (dedupEntry.cleanupTimeout) {
          clearTimeout(dedupEntry.cleanupTimeout);
        }
        dedupEntry.cleanupTimeout = setTimeout(() => {
          resyncDedupRegistry.delete(blogID);
        }, RESYNC_DEDUP_WINDOW_MS);
        await done();
      }
    } catch (err) {
      dedupEntry.inFlight = false;
      dedupEntry.cooldownUntil = Date.now() + RESYNC_DEDUP_WINDOW_MS;
      if (dedupEntry.cleanupTimeout) {
        clearTimeout(dedupEntry.cleanupTimeout);
      }
      dedupEntry.cleanupTimeout = setTimeout(() => {
        resyncDedupRegistry.delete(blogID);
      }, RESYNC_DEDUP_WINDOW_MS);
      if (
        handleSyncLockError({
          err,
          res,
          blogID,
          action: "status resync",
        })
      ) {
        return;
      }

      return handle("Error in requestResync", err);
    }
  } else if (status.acceptedSharingLink) {
    try {
      // we send "ok" immediately to the macserver
      // because the initial transfer can take a while
      res.send("ok");

      await initialTransfer(blogID);
    } catch (err) {
      return handle("Error in initialTransfer", err);
    }
  } else if (status.error) {
    // The macserver reported an error: a setup failure (e.g. an invalid
    // sharing link, or the shared folder never appeared) or the shared folder
    // being deleted. The error is already persisted, with its code, by the
    // database.store() call above, which drives the dashboard error UI; here we
    // also push it onto the live status line. Reply before taking the sync lock
    // so we never hold the macserver's status request open while it waits on us.
    try {
      res.send("ok");

      const { done, folder } = await establishSyncLock(blogID);

      try {
        folder.status("Error: " + status.error);
        console.log("Error reported by macserver", {
          blogID,
          error: status.error,
        });
      } finally {
        await done();
      }
    } catch (err) {
      if (
        handleSyncLockError({
          err,
          res,
          blogID,
          action: "status setup error",
        })
      ) {
        return;
      }

      return handle("Error handling setup failure status", err);
    }
  } else {
    try {
      const { done, folder } = await establishSyncLock(blogID);

      res.send("ok");

      try {
        folder.status("Sync update from iCloud");
        console.log("Sync update from iCloud", status);
        folder.status("Sync complete");  
      } finally {
        await done();
      }
    } catch (err) {
      if (
        handleSyncLockError({
          err,
          res,
          blogID,
          action: "status update",
        })
      ) {
        return;
      }

      return handle("Error in syncFromiCloud", err);
    }
  }
};
