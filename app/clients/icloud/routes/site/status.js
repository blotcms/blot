const { promisify } = require("util");
const Blog = require("models/blog");
const database = require("../../database");
const initialTransfer = require("../../sync/initialTransfer");
const validateBlog = require("../../sync/validateBlog");
const getHealth = require("../../getHealth");
const establishSyncLock = require("sync/establishSyncLock");
const { handleSyncLockError } = require("../lock");
const email = require("helper/email");
const notificationCap = require("../../util/notificationCap");
const syncReport = require("clients/util/syncReport");
const stampLastSync = require("./stampLastSync");

const getBlog = promisify(Blog.get);

const RESYNC_DEDUP_WINDOW_MS = 10 * 1000;
// Process-local resync deduplication: if multiple Node processes handle requests,
// this in-memory guard will not deduplicate across processes.
const resyncDedupRegistry = new Map();

// The macserver can request a resync every few seconds while a user is
// moving folders around, so cap the admin email to one per blog per hour.
// The resync itself still runs every time. Per-process, like the guard above.
// (A resync only emails at all when it found something, see below.)
const notifyResyncRequested = notificationCap({
  max: 1,
  resetAfterMs: 60 * 60 * 1000,
});

// Longest macserver-supplied failure reason kept for the email.
const MAX_REASON_LENGTH = 500;

// Adapts the capped ICLOUD_RESYNC_ISSUE email to the (err, locals, callback)
// shape syncReport.send expects, adding the macserver's reason: its own
// description of what failed (eg. "upload for Posts/x.md failed after
// retries"), which older macserver versions don't send.
const resyncReportSender = (blogID, reason) => (err, locals, callback) => {
  const result = notifyResyncRequested(blogID, () =>
    email.ICLOUD_RESYNC_ISSUE(null, Object.assign({}, locals, { reason }), callback)
  );

  if (result === "suppressed") {
    console.log("Resync report suppressed", { blogID });
    callback();
  }
};

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

  // Not part of the account: it only goes into the resync report.
  const { reason: reportedReason, ...accountStatus } = status;
  const reason =
    typeof reportedReason === "string" && reportedReason
      ? reportedReason.slice(0, MAX_REASON_LENGTH)
      : undefined;

  try {
    // store the status in the database
    await database.store(blogID, accountStatus);

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

    let lockAcquired = false;

    try {
      // This will throw if the sync lock is already established
      const { done, folder } = await establishSyncLock(blogID);
      lockAcquired = true;

      // Set when the account check below turns the resync down, so no resync
      // runs and the macserver is told to retry.
      let refused = false;

      // validateBlog releases the lock itself, right after its walk and
      // before Fix(), so once it has been handed the lock this flag stops the
      // finally below from releasing it a second time.
      let lockHandedOff = false;

      try {
        // The request may have waited on the lock while the blog was
        // disconnected, or disconnected and reconnected (loadAccount only
        // checked before that). Resyncing then would walk an empty or
        // half-transferred remote folder and remove local files, so check
        // again now that nothing else can change the folder.
        const account = await database.get(blogID);
        if (!account || !account.sharingLink) {
          console.log("Resync skipped: blog no longer connected", { blogID });
          refused = true;
          return res.status(400).send("Blog is not connected to iCloud Drive");
        }
        if (
          account.setupComplete !== true ||
          account.transferringToiCloud === true
        ) {
          console.log("Resync skipped: blog setup not complete", { blogID });
          refused = true;
          return res.status(409).send("Blog has not completed set up");
        }

        // Loaded before replying, so a failed load (eg. Redis trouble) gets
        // a 500 the macserver retries, rather than an "ok" that ends its
        // retries with no resync.
        let blog;
        try {
          blog = await getBlog({ id: blogID });
        } catch (err) {
          console.error("Resync failed: couldn't load blog", blogID, err);
          refused = true;
          return res.status(500).send("Failed to load blog");
        }

        if (!blog || blog.isDisabled || blog.client !== "icloud") {
          console.log("Resync skipped: blog is gone, disabled or not on iCloud", {
            blogID,
          });
          return res.send("ok");
        }

        // A resync request means the macserver saw something go wrong with
        // its pushes (eg. it gave up retrying after the folder was locked), so
        // the blog is active and should be checked by the next sweep.
        await stampLastSync(blogID);

        // Now that we have the sync lock, we can send "ok" to the
        // macserver since the resync can take a while
        res.send("ok");

        folder.status("Resync requested");
        console.log("Resync requested from iCloud", { blogID, reason });


        const report = syncReport.create();

        // Since we treat the iCloud folder as the source of truth,
        // there is the risk that files added to Blot's folder (e.g. preview files)
        // or template files which were edited online will be clobbered. 
        // in in future, we might be able to implement a system to merge
        // but for now we'll just sync down from iCloud.
        //
        // The same walk and Fix() as the hourly validation, which records
        // what it found in the report. The account was checked above with
        // the lock held, so it isn't checked again.
        lockHandedOff = true;
        await validateBlog(blog, report, {
          publish: folder.status.bind(folder),
          lock: { folder, done },
        });
        folder.status("Resync complete");

        // Emailed straight away rather than waiting for the hourly sweep, and
        // only if the resync turned up something: changes that reached Blot
        // only because of it, Fix() repairs, or a phase that failed. No
        // `client`: that would make send() replace the hourly sweep's
        // memory of what it already reported with just this blog's.
        await syncReport.send(report, resyncReportSender(blogID, reason), "iCloud:", {
          getHealth,
        });
      } finally {
        dedupEntry.inFlight = false;
        if (dedupEntry.cleanupTimeout) {
          clearTimeout(dedupEntry.cleanupTimeout);
        }
        if (refused) {
          // As with a busy lock below: a cooldown would answer the
          // macserver's retry "ok" without resyncing, so it would stop
          // retrying (eg. before a reconnect's setup completes).
          resyncDedupRegistry.delete(blogID);
        } else {
          dedupEntry.cooldownUntil = Date.now() + RESYNC_DEDUP_WINDOW_MS;
          dedupEntry.cleanupTimeout = setTimeout(() => {
            resyncDedupRegistry.delete(blogID);
          }, RESYNC_DEDUP_WINDOW_MS);
        }
        if (!lockHandedOff) await done();
      }
    } catch (err) {
      dedupEntry.inFlight = false;
      if (dedupEntry.cleanupTimeout) {
        clearTimeout(dedupEntry.cleanupTimeout);
      }
      if (lockAcquired) {
        dedupEntry.cooldownUntil = Date.now() + RESYNC_DEDUP_WINDOW_MS;
        dedupEntry.cleanupTimeout = setTimeout(() => {
          resyncDedupRegistry.delete(blogID);
        }, RESYNC_DEDUP_WINDOW_MS);
      } else {
        // No resync ran (the lock was busy), and the 423 tells the macserver
        // to retry. A cooldown here would answer that retry "ok" without
        // resyncing, so it would stop retrying and the change could be lost.
        resyncDedupRegistry.delete(blogID);
      }
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
