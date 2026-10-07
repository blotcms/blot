const scheduler = require("node-schedule");
const { promisify } = require("util");
const Blog = require("models/blog");
const Entries = require("models/entries");
const clfdate = require("helper/clfdate");
const email = require("helper/email");
const Fix = require("sync/fix");
const establishSyncLock = require("sync/establishSyncLock");
const syncReport = require("clients/util/syncReport");
const health = require("clients/health");
const { measure: measureEventLoop } = require("helper/eventLoopMonitor");
const database = require("./database");
const { classify } = require("./database/error");
// sync.js directly, not sync/index.js: that is the webhook/poll entry point
// and stamps lastSync, which would keep every blog eligible forever.
const sync = require("./sync/sync");

const getBlog = promisify(Blog.get);
// getAllTotal, not getTotal - Fix()'s entry-ghosts (Entries.each) scans the
// "all" list (drafts/pages/scheduled/deleted included), not just published
// "entries", so getTotal would under-count the workload this field tracks.
const getEntryTotal = promisify(Entries.getAllTotal);

const ONE_HOUR_IN_MS = 60 * 60 * 1000;

// Google Drive has no incremental sync: a normal sync already walks the whole
// folder, listing each directory and comparing md5/modifiedTime with cached
// state, without re-downloading or re-hashing unchanged files. That makes it
// cheap enough to run hourly, so the sweep is a plain sync (never reset: true,
// which wipes the id <-> path mappings and could make write.js create
// duplicate Drive files if it failed part way) followed by Fix(). Whatever the
// walk had to change is a change the webhook and pollers missed.
//
// There is no catch-up sync afterwards, unlike Dropbox: a sync dropped while
// we held the lock is retried by pollDriveActivity and hotDocPoller, and the
// walk is itself a full sync. Google Docs the walk downloads are enqueued into
// hotDocPoller by download(); that is fine for genuinely missed docs.
//
// Fix() does many sequential Redis round trips over the shared connection,
// and running it after every sync starved folder lock heartbeats until a
// lease expired and the process crashed, hence once an hour, outside the lock.

// Every locked sync publishes a "Syncing"/"Synced" status - the sweep's own
// walk included - so statuses can't say whether a real sync happened. Instead
// sync/index.js (webhooks, pollers, hot docs) stamps account.lastSync, and the
// sweep, which doesn't go through it, never does. Blogs with no lastSync yet
// are skipped until their next real sync.
const hasRecentSync = (account) => {
  if (!account || typeof account.lastSync !== "number") return false;
  return Date.now() - account.lastSync <= ONE_HOUR_IN_MS;
};

// Event loop delay while one blog was validated, to find which blog and which
// phase blocks the loop (a stall longer than the folder lock TTL crashes the
// process). Every blog is logged so quiet blogs are a baseline. entryCount is
// included because Fix()'s entry-ghosts check does one sequential Redis round
// trip per entry - a large count is the leading suspect for starving another
// blog's lock heartbeat on the shared connection.
const logLag = (blogID, phase, entryCount, { durationMs, maxLagMs, p99LagMs }) => {
  console.log(
    clfdate(),
    "Google Drive: validation lag",
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
        console.error(clfdate(), "Google Drive: Fix error for blog", blog.id, error);
      }
      resolve({ error, report });
    });
  });

// Walks the blog's folder while holding its folder lock, so it can't race a
// webhook sync. Resolves to sync's summary, or false if the walk failed.
const walkWithLock = async (blogID, publish) => {
  const { folder, done } = await establishSyncLock(blogID);
  let error = null;

  try {
    return await sync(blogID, publish, folder.update);
  } catch (err) {
    error = err;
    throw err;
  } finally {
    // done rejects with the error it is given, once the lock is released
    await done(error).catch((err) => {
      if (err !== error)
        console.error(clfdate(), "Google Drive: Error releasing lock", blogID, err);
    });
  }
};

let validationRunning = false;

const runValidation = async () => {
  if (validationRunning) {
    console.log(clfdate(), "Google Drive: Validation still running, skipping");
    return;
  }

  validationRunning = true;

  try {
    await validateAllBlogs();
  } catch (err) {
    console.error(clfdate(), "Google Drive: Sync validation failed", err);
  } finally {
    validationRunning = false;
  }
};

const validateAllBlogs = async () => {
  console.log(clfdate(), "Google Drive: Running hourly sync validation");

  const report = syncReport.create();
  let checkedBlogs = 0;

  await database.blog.iterate(async (blogID, account) => {
    let blog;
    let phase = "validation";

    try {
      // Setup holds the lock while it builds the folder, and walking it
      // mid-setup risks removing files that haven't been uploaded yet.
      if (!account.folderId || account.preparing) return;
      if (!account.serviceAccountId || classify(account)) return;
      if (!hasRecentSync(account)) return;

      blog = await getBlog({ id: blogID });
      if (!blog || blog.client !== "google-drive") return;

      checkedBlogs += 1;

      const publish = (...args) => {
        console.log(clfdate(), "Google Drive:", blogID, ...args);
      };

      const entryCount = await getEntryTotal(blogID).catch(() => null);

      let summary;
      const stopWalkMeasure = measureEventLoop();
      phase = "walk";

      try {
        summary = await walkWithLock(blogID, publish);
        logLag(blogID, "walk", entryCount, stopWalkMeasure());
      } catch (err) {
        stopWalkMeasure();
        // A sync is already running for this blog, and that sync will pick
        // up whatever changed. Check it again next hour - unless it has held
        // the lock for suspiciously long, which recordBusy reports.
        if (err.message === "Failed to acquire folder lock") {
          console.log(clfdate(), "Google Drive: Skipping busy blog", blogID);
          await syncReport.recordBusy(report, blog);
          checkedBlogs -= 1;
          return;
        }
        // Disabled since the sweep started
        if (/^Cannot sync blog/.test(err.message)) {
          checkedBlogs -= 1;
          return;
        }
        throw err;
      }

      // sync.js resolves false when the walk failed, which is not "no
      // changes". Don't run Fix() on a folder we couldn't read.
      if (!summary) {
        const latest = await database.blog.get(blogID);
        // The user trashed or unshared the folder; the dashboard already
        // shows that, so it isn't a sync problem to report.
        if (classify(latest) === health.CODES.SOURCE_MISSING) {
          console.log(clfdate(), "Google Drive: Folder missing for blog", blogID);
          return;
        }
        throw new Error("walk failed (see logs)");
      }

      syncReport.recordChanges(report, blog, summary);

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
        "Google Drive: Error validating sync for blog",
        blogID,
        err
      );
      if (blog) syncReport.recordError(report, blog, phase, err);
    }
  });

  const reported = syncReport.view(report).blogs.length;

  console.log(
    clfdate(),
    "Google Drive: Sync validation complete",
    `checked=${checkedBlogs}`,
    `issues=${reported}`
  );

  syncReport.send(report, email.GOOGLE_DRIVE_SYNC_ISSUE, "Google Drive:");
};

module.exports = function scheduleValidation() {
  console.log(clfdate(), "Google Drive: Scheduling hourly sync validation");
  // :30 so it doesn't overlap Dropbox's :00 validation
  scheduler.scheduleJob("30 * * * *", runValidation);
};

// Exposed for tests
module.exports.runValidation = runValidation;
module.exports.validateAllBlogs = validateAllBlogs;
