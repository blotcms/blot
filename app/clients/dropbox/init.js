const scheduler = require("node-schedule");
const { promisify } = require("util");
const Blog = require("models/blog");
const Entries = require("models/entries");
const clfdate = require("helper/clfdate");
const email = require("helper/email");
const resetToBlot = require("./sync/reset-to-blot");
const { get: getAccount, set: setAccount } = require("./database");
const Fix = require("sync/fix");
const establishSyncLock = require("sync/establishSyncLock");
const sync = promisify(require("./sync"));
const countChanges = require("./sync/count-changes");
const { measure: measureEventLoop } = require("helper/eventLoopMonitor");

const getAllIDs = promisify(Blog.getAllIDs);
const getBlog = promisify(Blog.get);
const getDropboxAccount = promisify(getAccount);
const setDropboxAccount = promisify(setAccount);
// getAllTotal, not getTotal - Fix()'s entry-ghosts (Entries.each) scans the
// "all" list (drafts/pages/scheduled/deleted included), not just published
// "entries", so getTotal would under-count the workload this field tracks.
const getEntryTotal = promisify(Entries.getAllTotal);

const ONE_HOUR_IN_MS = 60 * 60 * 1000;
const FIFTEEN_MINUTES_IN_MS = 15 * 60 * 1000;

// Runs resetToBlot while holding the blog's folder lock, so it can't race a
// webhook sync. resetToBlot updates the database as it changes files, since it
// advances the Dropbox cursor and later syncs would never revisit them.
const resetToBlotWithLock = async (blogID, publish) => {
  const { folder, done } = await establishSyncLock(blogID);
  let error = null;

  try {
    return await resetToBlot(blogID, publish, folder.update);
  } catch (err) {
    error = err;
    throw err;
  } finally {
    // done rejects with the error it is given, once the lock is released
    await done(error).catch((err) => {
      if (err !== error)
        console.error(clfdate(), "Dropbox: Error releasing lock", blogID, err);
    });
  }
};

// Event loop delay while one blog was validated, to find which blog and which
// phase blocks the loop (a stall longer than the folder lock TTL crashes the
// process). Every blog is logged so quiet blogs are a baseline. entryCount is
// included because "fix+catch-up" runs Fix()'s entry-ghosts check, which does
// one sequential Redis round trip per entry - a large count is the leading
// suspect for starving another blog's lock heartbeat on the shared
// connection, and without it that theory can only be checked after the fact.
const logLag = (blogID, phase, entryCount, { durationMs, maxLagMs, p99LagMs }) => {
  console.log(
    clfdate(),
    "Dropbox: validation lag",
    blogID,
    phase,
    `duration=${durationMs}ms`,
    `maxLag=${maxLagMs}ms`,
    `p99Lag=${p99LagMs}ms`,
    `entries=${entryCount == null ? "unknown" : entryCount}`
  );
};

const fixBlog = (blog) =>
  new Promise((resolve) => {
    Fix(blog, (err) => {
      if (err) {
        console.error(clfdate(), "Dropbox: Fix error for blog", blog.id, err);
      }
      resolve();
    });
  });

// Webhook syncs that arrive while we hold the lock give up waiting for it and
// are dropped, so run a normal sync once we release it. sync() stamps
// last_sync, which would keep the blog eligible for validation forever, so
// put the previous value back.
const catchUpSync = async (blog) => {
  let before;

  try {
    before = await getDropboxAccount(blog.id);
    await sync(blog);
  } catch (err) {
    console.error(clfdate(), "Dropbox: Catch-up sync error", blog.id, err);
  } finally {
    // Also on failure: sync() stamps last_sync as soon as it gets the lock
    if (before && typeof before.last_sync === "number") {
      await setDropboxAccount(blog.id, { last_sync: before.last_sync }).catch(
        (err) =>
          console.error(clfdate(), "Dropbox: Error restoring last_sync", err)
      );
    }
  }
};

const hasRecentSync = (account) => {
  if (!account || typeof account.last_sync !== "number") return false;
  return Date.now() - account.last_sync <= ONE_HOUR_IN_MS;
};

let validationRunning = false;

const runValidation = async () => {
  if (validationRunning) {
    console.log(clfdate(), "Dropbox: Validation still running, skipping");
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
  console.log(clfdate(), "Dropbox: Running hourly sync validation");

  let blogIDs = [];

  try {
    blogIDs = await getAllIDs();
  } catch (err) {
    console.error(clfdate(), "Dropbox: Failed to load blog IDs", err);
    return;
  }

  const blogsWithChanges = [];
  let checkedBlogs = 0;

  for (const blogID of blogIDs) {
    try {
      const blog = await getBlog({ id: blogID });
      if (!blog || blog.client !== "dropbox") continue;

      const account = await getDropboxAccount(blogID);
      if (!hasRecentSync(account)) continue;

      checkedBlogs += 1;

      const publish = (...args) => {
        console.log(clfdate(), "Dropbox:", blogID, ...args);
      };

      const entryCount = await getEntryTotal(blogID).catch(() => null);

      let summary;
      const stopWalkMeasure = measureEventLoop();

      try {
        summary = await resetToBlotWithLock(blogID, publish);
        logLag(blogID, "walk", entryCount, stopWalkMeasure());
      } catch (err) {
        stopWalkMeasure();
        // A sync is already running for this blog, and that sync will pick
        // up whatever changed. Check it again next hour.
        if (err.message === "Failed to acquire folder lock") {
          console.log(clfdate(), "Dropbox: Skipping busy blog", blogID);
          checkedBlogs -= 1;
          continue;
        }
        throw err;
      }

      const changeCount = countChanges(summary);

      if (changeCount > 0) {
        blogsWithChanges.push({
          id: blogID,
          handle: blog.handle,
          truncatedId: blogID.slice(0, 12),
          changeCount,
          changeCountPlural: changeCount !== 1,
        });
      }

      const stopFollowUpMeasure = measureEventLoop();
      try {
        await fixBlog(blog);
        await catchUpSync(blog);
      } finally {
        logLag(blogID, "fix+catch-up", entryCount, stopFollowUpMeasure());
      }
    } catch (err) {
      console.error(
        clfdate(),
        "Dropbox: Error validating sync for blog",
        blogID,
        err
      );
    }
  }

  console.log(
    clfdate(),
    "Dropbox: Sync validation complete",
    `checked=${checkedBlogs}`,
    `issues=${blogsWithChanges.length}`
  );

  if (blogsWithChanges.length === 0) return;

  email.DROPBOX_SYNC_ISSUE(null, { blogs: blogsWithChanges }, function (err) {
    if (err) {
      console.error(clfdate(), "Dropbox: Failed to send issue email", err);
    } else {
      console.log(clfdate(), "Dropbox: Sent sync issue report email");
    }
  });
};

const resyncRecentSyncsOnStartup = async () => {
  console.log(clfdate(), "Dropbox: Checking for recent syncs on startup");

  let blogIDs = [];

  try {
    blogIDs = await getAllIDs();
  } catch (err) {
    console.error(clfdate(), "Dropbox: Failed to load blog IDs", err);
    return;
  }

  const blogsToResync = [];

  for (const blogID of blogIDs) {
    try {
      const blog = await getBlog({ id: blogID });
      if (!blog || blog.client !== "dropbox") continue;

      const account = await getDropboxAccount(blogID);
      if (!account || typeof account.last_sync !== "number") continue;

      if (Date.now() - account.last_sync >= FIFTEEN_MINUTES_IN_MS) continue;

      blogsToResync.push({ blog, blogID });
    } catch (err) {
      console.error(
        clfdate(),
        "Dropbox: Error checking recent sync for blog",
        blogID,
        err
      );
    }
  }

  if (!blogsToResync.length) return;

  setImmediate(async () => {
    for (const { blog, blogID } of blogsToResync) {
      const publish = (...args) => {
        console.log(clfdate(), "Dropbox:", blogID, ...args);
      };

      try {
        console.log(clfdate(), "Dropbox: Resyncing recent blog", blogID);
        await resetToBlotWithLock(blogID, publish);
        await fixBlog(blog);
        await catchUpSync(blog);
        console.log(clfdate(), "Dropbox: Resync complete for blog", blogID);
      } catch (err) {
        if (err.message === "Failed to acquire folder lock") {
          console.log(clfdate(), "Dropbox: Skipping busy blog", blogID);
          continue;
        }
        console.error(
          clfdate(),
          "Dropbox: Resync error for blog",
          blogID,
          err
        );
      }
    }
  });
};

module.exports = async function init() {
  console.log(clfdate(), "Dropbox: Scheduling hourly sync validation");
  scheduler.scheduleJob("0 * * * *", runValidation);
  resyncRecentSyncsOnStartup().catch(function (err) {
    console.error(clfdate(), "Dropbox: Startup resync failed", err);
  });
};
