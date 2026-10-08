const { promisify } = require("util");
const Blog = require("models/blog");
const Entries = require("models/entries");
const clfdate = require("helper/clfdate");
const establishSyncLock = require("sync/establishSyncLock");
const Fix = require("sync/fix");
const syncReport = require("clients/util/syncReport");
const { measure: measureEventLoop } = require("helper/eventLoopMonitor");
const database = require("../database");
const { shouldSkipBackgroundSync } = require("../error");
const syncFromiCloud = require("./fromiCloud");

const getBlog = promisify(Blog.get);
// getAllTotal, not getTotal: Fix()'s entry-ghosts check scans every entry
// (drafts, pages, scheduled, deleted included), not just published ones.
const getEntryTotal = promisify(Entries.getAllTotal);

const LOCK_BUSY_MESSAGE = "Failed to acquire folder lock";
// Thrown by sync() when the blog is disabled or gone.
const CANNOT_SYNC_MESSAGE = "Cannot sync blog";

// Returned by walk() instead of a summary when it finds the account unfit to
// walk after acquiring the lock. Callers must treat this as "nothing
// happened" - not a change to count, and not something to follow up with
// Fix().
const REFUSED = Symbol("icloud-walk-refused");

// Runs syncFromiCloud while holding the blog's folder lock, so the removals
// it makes can't race an upload from the macserver, or an initial transfer
// whose files haven't reached iCloud yet. The lock is released as soon as the
// walk is over, whether it worked or not. No catch-up sync afterwards (unlike
// Dropbox's sweep): a macserver push that finds the lock busy gets a 423,
// retries, and then requests a full resync through /status, so nothing is
// dropped while a validation holds the lock.
//
// With no lock it takes one, and looks at the account again once it has it:
// the caller's check ran before the lock was acquired and establishSyncLock
// may have waited for it. A stored error (which includes SOURCE_MISSING, the
// watcher's "folder deleted") or an unfinished transfer means iCloud isn't a
// source of truth for this blog right now, and walking it would remove Blot's
// own files. A caller that hands in a lock has made that check itself, with
// the lock held.
const walk = async (blogID, publish, heldLock) => {
  const { folder, done } = heldLock || (await establishSyncLock(blogID));
  let error = null;

  try {
    if (!heldLock) {
      const account = await database.get(blogID);

      if (shouldSkipBackgroundSync(account)) {
        publish("Skipping validation: setup incomplete or stored error");
        return REFUSED;
      }
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
// the impact on the shared Redis connection (and the macserver, via
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

// Checks one blog against iCloud and records what it found in the report
// (see clients/util/syncReport): walks the folder under the sync lock,
// records the walk, then runs Fix() outside the lock and records that. Used
// by the hourly sweep and by the resync the macserver requests after a failed
// push, so both report the same way.
//
//   options.publish: log/status function for the walk.
//   options.lock:    a { folder, done } the caller already holds, with its
//                    eligibility already checked. Without it the blog's lock
//                    is taken here (rejecting with "Failed to acquire folder
//                    lock" if it is busy is handled: the blog is skipped) and
//                    the account is checked again once it is held. Either
//                    way the lock is released right after the walk, so the
//                    caller must not call done() itself once this is called.
//
// Resolves to true if the blog was validated and recorded, false if it was
// skipped (busy lock, disabled or removed blog, an account that became unfit)
// and nothing happened. A walk or Fix() that fails is recorded as an error
// and doesn't reject.
module.exports = async function validateBlog(blog, report, options) {
  const { publish, lock } = options;
  const blogID = blog.id;
  const entryCount = await getEntryTotal(blogID).catch(() => null);
  let phase = "walk";

  try {
    let summary;
    const stopWalkMeasure = measureEventLoop();

    try {
      summary = await walk(blogID, publish, lock);
      logLag(blogID, "walk", entryCount, stopWalkMeasure());
    } catch (err) {
      stopWalkMeasure();

      // A sync is already running for this blog and will pick up whatever
      // changed. Check it again next hour (a lock that stays held is caught
      // by the sweep's stuck-lock check).
      if (err.message === LOCK_BUSY_MESSAGE) {
        console.log(clfdate(), "iCloud: Skipping busy blog", blogID);
        return false;
      }

      // The blog was disabled or removed since it was queued.
      if (String(err.message).startsWith(CANNOT_SYNC_MESSAGE)) return false;

      throw err;
    }

    // The account became unfit between the caller's cheap check and the lock
    // being acquired. Same as never having attempted this blog.
    if (summary === REFUSED) return false;

    // syncFromiCloud swallows the failures it meets (macserver down,
    // downloads that failed) and returns normal-looking counts, so an outage
    // would read as "no changes". recordWalk reports those as a walk error,
    // with the changes the walk did apply, and Fix() is skipped: the folder
    // is only partly reconciled and the error is what needs attention.
    if (!syncReport.recordWalk(report, blog, summary)) return true;

    // Fix() persists parts of the blog it is handed (menu-ghosts writes
    // blog.menu), and the walk may have just added a menu page. The snapshot
    // loaded before the walk would have that write drop it.
    phase = "fix";
    const current = await getBlog({ id: blogID });
    // Deleted meanwhile, so there is nothing left to repair.
    if (!current) return true;

    const stopFixMeasure = measureEventLoop();
    try {
      const fixed = await fixBlog(current);
      syncReport.recordFix(report, blog, fixed.report);
      if (fixed.error) {
        syncReport.recordError(report, blog, "fix", fixed.error);
      }
    } finally {
      logLag(blogID, "fix", entryCount, stopFixMeasure());
    }

    return true;
  } catch (err) {
    console.error(
      clfdate(),
      "iCloud: Error validating sync for blog",
      blogID,
      err
    );
    syncReport.recordError(report, blog, phase, err);
    return true;
  }
};
