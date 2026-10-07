const scheduler = require("node-schedule");
const { promisify } = require("util");
const Blog = require("models/blog");
const clfdate = require("helper/clfdate");
const email = require("helper/email");
const monitorMacServerStats = require("./util/monitorMacServerStats");
const establishSyncLock = require("sync/establishSyncLock");
const initialTransfer = require("./sync/initialTransfer");
const database = require("./database");
const getHealth = require("./getHealth");
const { shouldSkipBackgroundSync } = require("./error");
const syncFromiCloud = require("./sync/fromiCloud");
const syncToiCloud = require("./sync/toiCloud");
const Entries = require("models/entries");
const Fix = require("sync/fix");
const syncReport = require("clients/util/syncReport");
const { measure: measureEventLoop } = require("helper/eventLoopMonitor");

const getBlog = promisify(Blog.get);
// getAllTotal, not getTotal: Fix()'s entry-ghosts check scans every entry
// (drafts, pages, scheduled, deleted included), not just published ones.
const getEntryTotal = promisify(Entries.getAllTotal);

const ONE_HOUR_IN_MS = 60 * 60 * 1000;
const RESYNC_WINDOW = 1000 * 60 * 10; // 10 minutes

const getLastSyncDateStamp = (blogID) => {
  return new Promise((resolve, reject) => {
    Blog.getStatuses(blogID, { pageSize: 1 }, (err, res) => {
      if (err) return reject(err);

      const statuses = res.statuses;

      if (!statuses || statuses.length === 0) {
        return resolve(null);
      }
      resolve(statuses[0].datestamp);
    });
  });
};

const resyncRecentlySynced = async (options = {}) => {
  const windowMs =
    typeof options.windowMs === "number" ? options.windowMs : RESYNC_WINDOW;
  const notify = options.notify !== undefined ? options.notify : false;
  const resyncContext = notify ? "hourly validation" : "startup resync";

  console.log(
    clfdate(),
    "Resyncing recently synced blogs",
    `(${resyncContext})`
  );

  await database.iterate(async (blogID, account) => {
    if (shouldSkipBackgroundSync(account)) {
      console.log(
        clfdate(),
        "Skipping resync (setup incomplete or stored error): ",
        blogID
      );
      return;
    }

    const lastSync = await getLastSyncDateStamp(blogID);

    if (!lastSync) {
      console.log(clfdate(), "No last sync date found for blogID: ", blogID);
      return;
    }

    const minutesAgo = Math.floor((Date.now() - lastSync) / 1000 / 60);

    // if the blog last synced within the last 10 minutes, we want to resync
    // because we might have missed some events
    if (Date.now() - lastSync < windowMs) {
      console.log(clfdate(), "Resyncing blog: ", blogID);

      // Ensure the hourly sync check is always gated by the sync
      // lock to prevent files from being removed from Blot 
      // during an initial setup. This prevents data loss.
      let folder;
      let done;

      try {
        ({ folder, done } = await establishSyncLock(blogID));
      } catch (error) {
        console.warn(
          clfdate(),
          "Blog is currently syncing elsewhere, skipping resync:",
          blogID
        );
        return;
      }
      try {
        // We don't sync to iCloud here because we want to respect
        // the state of the iCloud folder. It's possible that Blot
        // has made some folder changes which are unsynced but we 
        // prefer to destroy those rather than re-upload files
        // which were deleted on iCloud.
        await syncFromiCloud(blogID, folder.status, folder.update);
        console.log(clfdate(), "Finished resyncing blog: ", blogID);
      } catch (error) {
        console.error(clfdate(), "Error resyncing blog: ", blogID, error);
      } finally {
        await done();
      }
    } else {
      console.log(
        clfdate(),
        "Skipping resync of blog which last synced",
        minutesAgo,
        "minutes ago"
      );
    }
  });

  console.log(
    clfdate(),
    "Finished resyncing recently synced blogs",
    `(${resyncContext})`
  );
};

// Eligible for the sweep only if the macserver pushed something in the last
// hour (routes/site stamp lastSync). Not Blog.getStatuses: taking the folder
// lock writes "Syncing"/"Synced" statuses, so the sweep itself would make
// every blog look recently synced and be re-walked every hour forever.
const hasRecentSync = (account) => {
  if (!account || typeof account.lastSync !== "number") return false;
  return Date.now() - account.lastSync <= ONE_HOUR_IN_MS;
};

// Returned by syncFromiCloudWithLock instead of a summary when it finds the
// account unfit to walk after acquiring the lock. Callers must treat this as
// "nothing happened" - not a change to count, and not something to follow up
// with Fix().
const REFUSED = Symbol("icloud-walk-refused");

const LOCK_BUSY_MESSAGE = "Failed to acquire folder lock";
// Thrown by sync() when the blog is disabled or gone.
const CANNOT_SYNC_MESSAGE = "Cannot sync blog";

// Runs syncFromiCloud while holding the blog's folder lock, so the removals
// it makes can't race an upload from the macserver, or an initial transfer
// whose files haven't reached iCloud yet. No catch-up sync afterwards (unlike
// Dropbox's sweep): a macserver push that finds the lock busy gets a 423,
// retries, and then requests a full resync through /status, so nothing is
// dropped while the sweep holds the lock.
const syncFromiCloudWithLock = async (blogID, publish) => {
  const { folder, done } = await establishSyncLock(blogID);
  let error = null;

  try {
    // The caller's account check ran before the lock was acquired and
    // establishSyncLock may have waited for it, so look again. A stored error
    // (which includes SOURCE_MISSING, the watcher's "folder deleted") or an
    // unfinished transfer means iCloud isn't a source of truth for this blog
    // right now, and walking it would remove Blot's own files.
    const account = await database.get(blogID);

    if (shouldSkipBackgroundSync(account)) {
      publish("Skipping validation: setup incomplete or stored error");
      return REFUSED;
    }

    return await syncFromiCloud(blogID, publish, folder.update);
  } catch (err) {
    error = err;
    throw err;
  } finally {
    // done rejects with the error it is given, once the lock is released
    await done(error).catch((err) => {
      if (err !== error)
        console.error(clfdate(), "iCloud: Error releasing lock", blogID, err);
    });
  }
};

// Event loop delay while one blog was validated, so the operator can watch
// the sweep's impact on the shared Redis connection (and the macserver, via
// duration) after it is switched on, and find which blog and phase block the
// loop. Every blog is logged so quiet blogs are a baseline. entryCount is
// there because Fix()'s entry-ghosts check does one sequential Redis round
// trip per entry.
const logLag = (blogID, phase, entryCount, { durationMs, maxLagMs, p99LagMs }) => {
  console.log(
    clfdate(),
    "iCloud: validation lag",
    blogID,
    phase,
    `duration=${durationMs}ms`,
    `maxLag=${maxLagMs}ms`,
    `p99Lag=${p99LagMs}ms`,
    `entries=${entryCount == null ? "unknown" : entryCount}`
  );
};

// Never rejects: resolves with Fix's error and report so the caller decides
// what to report. Fix() can fail part way through and still return the
// repairs it made before that, hence both.
const fixBlog = (blog) =>
  new Promise((resolve) => {
    Fix(blog, (error, report) => {
      if (error) {
        console.error(clfdate(), "iCloud: Fix error for blog", blog.id, error);
      }
      resolve({ error, report });
    });
  });

let validationRunning = false;

// The sweep is sequential and a slow macserver can stretch it past an hour.
const runValidation = async () => {
  if (validationRunning) {
    console.log(clfdate(), "iCloud: Validation still running, skipping");
    return;
  }

  validationRunning = true;

  try {
    await validateAllBlogs();
  } finally {
    validationRunning = false;
  }
};

const validateAllBlogs = async () => {
  console.log(clfdate(), "iCloud: Running hourly sync validation");

  const report = syncReport.create();
  let checkedBlogs = 0;

  try {
    await database.iterate(async (blogID, account) => {
      let blog;
      let phase = "validation";

      try {
        blog = await getBlog({ id: blogID });
        if (!blog || blog.isDisabled || blog.client !== "icloud") return;

        // Deleting or unsharing the folder, or running out of iCloud storage,
        // is the user's doing, not a bug, so there is nothing to walk or
        // report. (Such an account also carries a stored error, which
        // shouldSkipBackgroundSync would skip anyway.)
        if (await syncReport.hasUserSideIssue(blogID, getHealth)) return;

        // Before the stored-error and recency filters: a stuck lock is a
        // bug whatever state the account is in, and the macserver stamped
        // lastSync when the sync that now holds the lock began, over an
        // hour ago.
        if (await syncReport.recordStuckLock(report, blog)) return;

        if (shouldSkipBackgroundSync(account)) return;
        if (!hasRecentSync(account)) return;

        checkedBlogs += 1;

        const publish = (...args) => {
          console.log(clfdate(), "iCloud:", blogID, ...args);
        };

        const entryCount = await getEntryTotal(blogID).catch(() => null);

        let summary;
        const stopWalkMeasure = measureEventLoop();
        phase = "walk";

        try {
          summary = await syncFromiCloudWithLock(blogID, publish);
          logLag(blogID, "walk", entryCount, stopWalkMeasure());
        } catch (err) {
          stopWalkMeasure();

          // A sync is already running for this blog and will pick up
          // whatever changed. Check it again next hour (a lock that stays
          // held is caught by the stuck-lock check above).
          if (err.message === LOCK_BUSY_MESSAGE) {
            console.log(clfdate(), "iCloud: Skipping busy blog", blogID);
            checkedBlogs -= 1;
            return;
          }

          // The blog was disabled or removed since the sweep started.
          if (String(err.message).startsWith(CANNOT_SYNC_MESSAGE)) {
            checkedBlogs -= 1;
            return;
          }

          throw err;
        }

        // The account became unfit between the cheap check above and the
        // lock being acquired. Same as never having attempted this blog.
        if (summary === REFUSED) {
          checkedBlogs -= 1;
          return;
        }

        // syncFromiCloud swallows the failures it meets (macserver down,
        // downloads that failed) and returns normal-looking counts, so an
        // outage would read as "no changes". recordWalk reports those as a
        // walk error, with the changes the walk did apply, and Fix() is
        // skipped: the folder is only partly reconciled and the error is
        // what needs attention.
        if (!syncReport.recordWalk(report, blog, summary)) return;

        const stopFixMeasure = measureEventLoop();
        try {
          phase = "fix";
          const fixed = await fixBlog(blog);
          syncReport.recordFix(report, blog, fixed.report);
          if (fixed.error) {
            syncReport.recordError(report, blog, "fix", fixed.error);
          }
        } finally {
          logLag(blogID, "fix", entryCount, stopFixMeasure());
        }
      } catch (err) {
        console.error(
          clfdate(),
          "iCloud: Error validating sync for blog",
          blogID,
          err
        );
        if (blog) syncReport.recordError(report, blog, phase, err);
      }
    });
  } catch (error) {
    console.error(clfdate(), "iCloud: Failed to iterate accounts", error);
  }

  const reported = await syncReport.send(
    report,
    email.ICLOUD_SYNC_ISSUE,
    "iCloud:",
    { client: "icloud", getHealth }
  );

  console.log(
    clfdate(),
    "iCloud: Sync validation complete",
    `checked=${checkedBlogs}`,
    `issues=${reported}`
  );
};

// Not scheduled (see init()). Reports through the same digest as the hourly
// sweep so the ICLOUD_SYNC_ISSUE template still renders if it is turned back on.
const resyncAllConnected = async ({ notify = true } = {}) => {
  console.log(clfdate(), "iCloud: Running daily resync for connected accounts");

  const report = syncReport.create();
  let checkedBlogs = 0;

  try {
    await database.iterate(async (blogID, account) => {
      if (shouldSkipBackgroundSync(account)) {
        console.log(
          clfdate(),
          "iCloud: Daily resync skipped (setup incomplete or stored error)",
          blogID,
          account && account.error
        );
        return;
      }

      try {
        const blog = await getBlog({ id: blogID });
        if (!blog || blog.client !== "icloud") return;

        checkedBlogs += 1;

        const publish = (...args) => {
          console.log(clfdate(), "iCloud: Daily resync", blogID, ...args);
        };

        let folder;
        let done;

        try {
          ({ folder, done } = await establishSyncLock(blogID));
        } catch (error) {
          console.warn(
            clfdate(),
            "iCloud: Daily resync skipped (already syncing)",
            blogID
          );
          return;
        }

        let summary;

        try {
          summary = await syncFromiCloud(blogID, folder.status, folder.update);
        } catch (error) {
          console.error(
            clfdate(),
            "iCloud: Error during daily resync for blog",
            blogID,
            error
          );
        } finally {
          await done();
        }

        if (!summary) return;

        syncReport.recordChanges(report, blog, summary);
      } catch (error) {
        console.error(
          clfdate(),
          "iCloud: Error iterating daily resync for blog",
          blogID,
          error
        );
      }
    });
  } catch (error) {
    console.error(clfdate(), "iCloud: Failed to iterate accounts", error);
    return;
  }

  console.log(
    clfdate(),
    "iCloud: Daily resync complete",
    `checked=${checkedBlogs}`,
    `issues=${syncReport.view(report).blogs.length}`
  );

  if (!notify) return;

  // No `client`: the once-per-occurrence memory belongs to the hourly sweep.
  await syncReport.send(report, email.ICLOUD_SYNC_ISSUE, "iCloud:", {
    getHealth,
  });
};

const init = async () => {

  await database.iterate(async (blogID, account) => {
    if (!account.transferringToiCloud) {
      return;
    }

    try {
      console.log("Resuming initial transfer for", blogID);
      await initialTransfer(blogID);
    } catch (error) {
      console.error("Error resuming initial transfer for", blogID, error);
    }
  });

  // At :45 because the Dropbox sweep runs at :00 and Google Drive's at :30,
  // and all three share the Redis connection.
  console.log(clfdate(), "iCloud: Scheduling hourly sync validation");
  scheduler.scheduleJob("45 * * * *", runValidation);

  // The daily full resync (resyncAllConnected) and the startup/"/started"
  // resync (resyncRecentlySynced) stay disabled: both walk every connected
  // (or recently synced) blog in one burst, a lot of load for the macserver
  // and Redis at once. Only the hourly sweep, which skips idle blogs, runs.

  monitorMacServerStats();
};

init.resyncRecentlySynced = resyncRecentlySynced;
init.resyncAllConnected = resyncAllConnected;
// Exposed for tests
init.validateAllBlogs = validateAllBlogs;
init.runValidation = runValidation;
init.syncFromiCloudWithLock = syncFromiCloudWithLock;
init.REFUSED = REFUSED;

module.exports = init;
