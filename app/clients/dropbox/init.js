const Blog = require("models/blog");
const Entries = require("models/entries");
const clfdate = require("helper/clfdate");
const drain = require("helper/drain");
const scheduleExclusive = require("clients/util/scheduleExclusive");
const onceAtStartup = require("clients/util/onceAtStartup");
const email = require("helper/email");
const syncReport = require("clients/util/syncReport");
const resetToBlot = require("./sync/reset-to-blot");
const resetFromBlot = require("./sync/reset-from-blot");
const { transferIncomplete } = require("./util/constants");
const { issueFromAccount } = require("./util/classifyError");
const cancelled = require("./util/cancelled");
const { get: getDropboxAccount } = require("./database");
const getHealth = require("./getHealth");
const Fix = require("sync/fix");
const establishSyncLock = require("sync/establishSyncLock");
const folderLock = require("sync/lock");
const config = require("config");
const sync = require("./sync");
const loadClient = require("./util/loadClient");
const { moveExistingFiles } = require("./routes/setup/createFolder");
const { measure: measureEventLoop } = require("helper/eventLoopMonitor");

const getAllIDs = () => Blog.getAllIDs();
const getBlog = (by) => Blog.get(by);
// getAllTotal, not getTotal - Fix()'s entry-ghosts (Entries.each) scans the
// "all" list (drafts/pages/scheduled/deleted included), not just published
// "entries", so getTotal would under-count the workload this field tracks.
const getEntryTotal = (blogID) => Entries.getAllTotal(blogID);

const ONE_HOUR_IN_MS = 60 * 60 * 1000;
const FIFTEEN_MINUTES_IN_MS = 15 * 60 * 1000;

// Returned by resetToBlotWithLock instead of a summary when it finds the
// transfer incomplete after acquiring the lock. Callers must treat this as
// "nothing happened" - not a change to count, and not something to follow up
// with fixBlog/catchUpSync.
const TRANSFER_INCOMPLETE = Symbol("dropbox-transfer-incomplete");

// Runs resetToBlot while holding the blog's folder lock, so it can't race a
// webhook sync. resetToBlot updates the database as it changes files, since it
// advances the Dropbox cursor and later syncs would never revisit them. A
// disconnect stops the walk part way (folder.signal, sync/seize.js): it
// rejects with an error util/cancelled.js recognises, and its writes to the
// folder are refused from then on (folder.run).
const resetToBlotWithLock = async (blogID, publish) => {
  const { folder, done } = await establishSyncLock(blogID);
  let error = null;

  try {
    return await folder.run(() =>
      resetToBlot(blogID, publish, folder.update, folder.signal)
    );
  } catch (err) {
    // resetToBlot itself refuses (see sync/reset-to-blot.js) if the account's
    // initial transfer to Dropbox hasn't finished - that guard runs right
    // after acquiring the lock's account read, so it's not vulnerable to the
    // caller's own (cheap, pre-lock) transferIncomplete check having gone
    // stale while establishSyncLock's retry loop waited to acquire this
    // lock. Treat that refusal as "nothing happened", not a failure.
    if (err && err.code === "DROPBOX_TRANSFER_INCOMPLETE") {
      publish(err.message);
      return TRANSFER_INCOMPLETE;
    }
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

// A deploy or crash that stops an initial transfer part way leaves
// transfer_pending set, and every automatic sync skips the blog until a
// transfer finishes. Resuming runs resetFromBlot with keepDropbox, which only
// uploads what Dropbox lacks: anything the person added or edited on Dropbox
// meanwhile is kept, and resumeTransfers then walks Dropbox into Blot. It
// runs its own quota check first. Not while the account has a durable error
// (revoked access, a missing folder, a full Dropbox), which needs the person
// to act first.
const canResumeTransfer = (account) =>
  !!account && account.transfer_pending === true && !issueFromAccount(account);

// Resumes one blog's initial transfer under its folder lock. Resolves true if
// the transfer finished, false if it was left alone: something holds the lock
// (a setup is running it), the transfer is no longer pending, or a disconnect
// aborted it. Rejects if the transfer fails, which leaves transfer_pending set.
const resumeTransfer = async (blogID) => {
  if ((await folderLock.inspect(blogID)).held) return false;

  let lock;
  try {
    lock = await establishSyncLock(blogID);
  } catch (err) {
    if (err.message === "Failed to acquire folder lock") return false;
    throw err;
  }

  const { folder, done } = lock;

  let error = null;
  try {
    // The setup this replaces may have finished just before we took the lock
    if (!canResumeTransfer(await getDropboxAccount(blogID))) return false;

    console.log(clfdate(), "Dropbox: Resuming initial transfer", blogID);
    folder.status("Syncing your folder to Dropbox");
    await folder.run(() =>
      resetFromBlot(blogID, folder.status, folder.signal, folder.update, {
        keepDropbox: true,
      })
    );
    return true;
  } catch (err) {
    if (cancelled(err, folder.signal)) return false;
    error = err;
    throw err;
  } finally {
    await done(error).catch((err) => {
      if (err !== error)
        console.error(clfdate(), "Dropbox: Error releasing lock", blogID, err);
    });
  }
};

// Blogs whose transfer this process is resuming, so a sweep doesn't queue a
// blog again while an earlier sweep's resume of it is still running
const resuming = new Set();

// Resumes each blog's transfer in turn. Then walks Dropbox into Blot, which
// brings in what the person added or edited on Dropbox while the transfer was
// paused (webhook syncs skip a blog while its transfer is pending, and the
// resume left those files alone), and syncs from the cursor. Nothing on Blot
// is lost: every Blot file is now on Dropbox. Never rejects.
const resumeTransfers = async (blogIDs) => {
  for (const blogID of blogIDs) {
    if (resuming.has(blogID)) continue;
    resuming.add(blogID);

    try {
      if (!(await resumeTransfer(blogID))) continue;
      console.log(clfdate(), "Dropbox: Resumed initial transfer", blogID);

      const publish = (...args) =>
        console.log(clfdate(), "Dropbox:", blogID, ...args);
      await resetToBlotWithLock(blogID, publish);

      const blog = await getBlog({ id: blogID });
      if (blog) await catchUpSync(blog);
    } catch (err) {
      if (err && err.message === "Failed to acquire folder lock") continue;
      if (cancelled(err)) continue;
      console.error(
        clfdate(),
        "Dropbox: Error resuming initial transfer",
        blogID,
        err
      );
    } finally {
      resuming.delete(blogID);
    }
  }
};

// Finishes moving each blog's files into the subfolder another blog's setup
// recorded for them (routes/setup/createFolder.js), when a deploy or crash
// cut the move short and no retried setup has finished it. The blog's syncs
// are paused until then (transferIncomplete). Then syncs it from the new
// folder. Never rejects.
const finishMoves = async (blogIDs) => {
  for (const blogID of blogIDs) {
    try {
      const blog = await getBlog({ id: blogID });
      if (!blog || blog.client !== "dropbox") continue;

      const { error, client } = await loadClient(blogID);
      if (error) throw error;

      console.log(clfdate(), "Dropbox: Finishing move into subfolder", blogID);
      await moveExistingFiles(client, blog, { resume: true });

      const account = await getDropboxAccount(blogID);
      if (account && !account.move_folder_id) await catchUpSync(blog);
    } catch (err) {
      if (err && err.message === "Failed to acquire folder lock") continue;
      console.error(clfdate(), "Dropbox: Error finishing move", blogID, err);
    }
  }
};

// Event loop delay while one blog was validated, to find which blog and which
// phase blocks the loop (a stall longer than the folder lock TTL crashes the
// process). Every blog is logged so quiet blogs are a baseline. entryCount is
// included because "fix+catch-up" runs Fix()'s entry-ghosts check, which does
// one sequential Redis round trip per entry - a large count is the leading
// suspect for starving another blog's lock heartbeat on the shared
// connection, and without it that theory can only be checked after the fact.
const logLag = (
  blogID,
  phase,
  entryCount,
  { durationMs, maxLagMs, p99LagMs }
) => {
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

// Never rejects: resolves with Fix's error and report so the caller decides
// what to report. Fix() can fail part way through and still return the
// repairs it made before that (err.report), hence both.
const fixBlog = async (blog) => {
  try {
    return { error: null, report: await Fix(blog) };
  } catch (error) {
    console.error(clfdate(), "Dropbox: Fix error for blog", blog.id, error);
    return { error, report: error.report };
  }
};

// Webhook syncs that arrive while we hold the lock give up waiting for it and
// are dropped, so run a normal sync once we release it. It does not stamp
// last_sync, which would keep the blog eligible for validation forever.
const catchUpSync = (blog) => sync(blog, { stampLastSync: false });

const hasRecentSync = (account) => {
  if (!account || typeof account.last_sync !== "number") return false;
  return Date.now() - account.last_sync <= ONE_HOUR_IN_MS;
};

const validateAllBlogs = async () => {
  console.log(clfdate(), "Dropbox: Running hourly sync validation");

  let blogIDs;

  try {
    blogIDs = await getAllIDs();
  } catch (err) {
    console.error(clfdate(), "Dropbox: Failed to load blog IDs", err);
    return;
  }

  const report = syncReport.create();
  const transfersToResume = [];
  const movesToFinish = [];
  let checkedBlogs = 0;

  for (const blogID of blogIDs) {
    // Every lock is refused while draining; the next hour's run covers the rest
    if (drain.isDraining()) {
      console.log(clfdate(), "Dropbox: Stopped sync validation for the drain");
      break;
    }

    let blog;
    let phase = "validation";

    try {
      blog = await getBlog({ id: blogID });
      if (!blog || blog.isDisabled || blog.client !== "dropbox") continue;

      // Revoked access, a deleted folder and a full Dropbox are the user's
      // doing, not bugs, so there is nothing to walk or report.
      if (await syncReport.hasUserSideIssue(blogID, getHealth)) continue;

      // Before the recency filter: sync() stamps last_sync when it takes the
      // lock, so a lock held for over an hour belongs to a blog that no
      // longer looks recently synced.
      const account = await getDropboxAccount(blogID);

      // A big first transfer can legitimately hold the lock for over an
      // hour, so it isn't a stuck lock. One nothing is running any more is
      // resumed once the sweep is done.
      if (account && account.transfer_pending === true) {
        if (canResumeTransfer(account)) transfersToResume.push(blogID);
        continue;
      }

      // A move into a subfolder cut short, finished once the sweep is done
      if (account && account.move_folder_id) {
        movesToFinish.push(blogID);
        continue;
      }

      if (await syncReport.recordStuckLock(report, blog)) continue;

      if (!hasRecentSync(account)) continue;
      if (transferIncomplete(account)) {
        console.log(
          clfdate(),
          "Dropbox: Skipping blog with incomplete transfer",
          blogID
        );
        continue;
      }

      checkedBlogs += 1;

      const publish = (...args) => {
        console.log(clfdate(), "Dropbox:", blogID, ...args);
      };

      const entryCount = await getEntryTotal(blogID).catch(() => null);

      let summary;
      const stopWalkMeasure = measureEventLoop();
      phase = "walk";

      try {
        summary = await resetToBlotWithLock(blogID, publish);
        logLag(blogID, "walk", entryCount, stopWalkMeasure());
      } catch (err) {
        stopWalkMeasure();
        // A sync is already running for this blog, and that sync will pick
        // up whatever changed. Check it again next hour (a lock that stays
        // held is caught by the stuck-lock check above).
        // Or a disconnect stopped the walk: the blog is no longer on Dropbox
        if (err.message === "Failed to acquire folder lock" || cancelled(err)) {
          console.log(clfdate(), "Dropbox: Skipping busy blog", blogID);
          checkedBlogs -= 1;
          continue;
        }
        throw err;
      }

      // The transfer became (or still was) incomplete by the time the lock
      // was acquired, even though the cheap pre-check above passed. Treat it
      // the same as never having attempted this blog.
      if (summary === TRANSFER_INCOMPLETE) {
        checkedBlogs -= 1;
        continue;
      }

      // A walk that skipped files reports a walk error (and the changes it
      // did apply), and Fix() and the catch-up sync are skipped for it.
      if (!syncReport.recordWalk(report, blog, summary)) continue;

      // Fix() persists parts of the blog it is handed (menu-ghosts writes
      // blog.menu), and the walk may have just added a menu page. The
      // snapshot loaded before the walk would have that write drop it.
      phase = "fix";
      const current = await getBlog({ id: blogID });
      // Deleted mid-sweep, so there is nothing left to repair or catch up.
      if (!current) continue;

      const stopFollowUpMeasure = measureEventLoop();
      try {
        const fixed = await fixBlog(current);
        syncReport.recordFix(report, blog, fixed.report);
        if (fixed.error) {
          syncReport.recordError(report, blog, "fix", fixed.error);
        }

        // Runs even if Fix() failed: it's independent of Fix()'s checks.
        phase = "catch-up sync";
        try {
          await catchUpSync(current);
        } catch (err) {
          // A live sync holds the lock and covers whatever we'd catch up,
          // same as the walk's busy skip.
          if (err.message !== "Failed to acquire folder lock") throw err;
          console.log(
            clfdate(),
            "Dropbox: Catch-up skipped, blog busy",
            blogID
          );
        }

        syncReport.recordChecked(report, blog);
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
      if (blog) syncReport.recordError(report, blog, phase, err);
    }
  }

  const reported = await syncReport.send(
    report,
    email.DROPBOX_SYNC_ISSUE,
    "Dropbox:",
    { client: "dropbox", getHealth }
  );

  console.log(
    clfdate(),
    "Dropbox: Sync validation complete",
    `checked=${checkedBlogs}`,
    `issues=${reported}`,
    `transfersToResume=${transfersToResume.length}`
  );

  // Not awaited: a big transfer can take longer than the hour, and the next
  // sweep waits for this one to finish. Returned in an object, which the
  // scheduler doesn't wait for, so specs can.
  return {
    resuming: resumeTransfers(transfersToResume),
    finishing: finishMoves(movesToFinish),
  };
};

const resyncRecentSyncsOnStartup = async () => {
  console.log(clfdate(), "Dropbox: Checking for recent syncs on startup");

  let blogIDs;

  try {
    blogIDs = await getAllIDs();
  } catch (err) {
    console.error(clfdate(), "Dropbox: Failed to load blog IDs", err);
    return;
  }

  const blogsToResync = [];
  const transfersToResume = [];
  const movesToFinish = [];

  for (const blogID of blogIDs) {
    try {
      const blog = await getBlog({ id: blogID });
      if (!blog || blog.client !== "dropbox") continue;

      const account = await getDropboxAccount(blogID);

      if (!blog.isDisabled && account && account.move_folder_id) {
        movesToFinish.push(blogID);
        continue;
      }

      // However long ago it started: a transfer can run for hours
      if (!blog.isDisabled && canResumeTransfer(account)) {
        transfersToResume.push(blogID);
        continue;
      }

      if (!account || typeof account.last_sync !== "number") continue;

      if (Date.now() - account.last_sync >= FIFTEEN_MINUTES_IN_MS) continue;
      if (transferIncomplete(account)) {
        console.log(
          clfdate(),
          "Dropbox: Skipping blog with incomplete transfer",
          blogID
        );
        continue;
      }

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

  for (const { blog, blogID } of blogsToResync) {
    const publish = (...args) => {
      console.log(clfdate(), "Dropbox:", blogID, ...args);
    };

    try {
      console.log(clfdate(), "Dropbox: Resyncing recent blog", blogID);
      const summary = await resetToBlotWithLock(blogID, publish);
      if (summary === TRANSFER_INCOMPLETE) {
        console.log(
          clfdate(),
          "Dropbox: Skipping blog with incomplete transfer",
          blogID
        );
        continue;
      }
      // Runs on every restart, so only log what Fix() repaired - the
      // hourly sweep is what reports repairs to the maintainer.
      const fixed = await fixBlog(blog);
      const repaired = syncReport.summarize(fixed.report);
      if (repaired) {
        console.log(clfdate(), "Dropbox: Fix repaired", blogID, repaired);
      }
      await catchUpSync(blog);
      console.log(clfdate(), "Dropbox: Resync complete for blog", blogID);
    } catch (err) {
      if (err.message === "Failed to acquire folder lock" || cancelled(err)) {
        console.log(clfdate(), "Dropbox: Skipping busy blog", blogID);
        continue;
      }
      console.error(clfdate(), "Dropbox: Resync error for blog", blogID, err);
    }
  }

  await finishMoves(movesToFinish);
  await resumeTransfers(transfersToResume);
};

// Outside a unit (development, tests) there is one name for every process
const startupJobName = () =>
  "dropbox-resync-recent" + (config.unit ? ":" + config.unit : "");

module.exports = async function init() {
  console.log(clfdate(), "Dropbox: Scheduling hourly sync validation");
  // One process per hour runs the sweep, and a sweep that outlasts the hour
  // is not overlapped by the next one (the "running" lock is cross-process).
  scheduleExclusive("dropbox-validation", "0 * * * *", validateAllBlogs);

  // Once per unit per deploy: a unit's two processes share it, but the
  // units stop and start minutes apart, and each must resync the syncs its
  // own stop killed.
  onceAtStartup(startupJobName(), resyncRecentSyncsOnStartup).catch(
    function (err) {
      console.error(clfdate(), "Dropbox: Startup resync failed", err);
    }
  );
};

// Exposed for tests: both resyncRecentSyncsOnStartup and validateAllBlogs
// gate on transferIncomplete() (util/constants.js) before ever calling
// resetToBlotWithLock for a blog, and resetToBlotWithLock itself rechecks it
// again once the lock is actually held (see its comment above).
module.exports.resyncRecentSyncsOnStartup = resyncRecentSyncsOnStartup;
module.exports.validateAllBlogs = validateAllBlogs;
module.exports.resetToBlotWithLock = resetToBlotWithLock;
module.exports.resumeTransfer = resumeTransfer;
module.exports.resumeTransfers = resumeTransfers;
module.exports.finishMoves = finishMoves;
module.exports.startupJobName = startupJobName;
module.exports.TRANSFER_INCOMPLETE = TRANSFER_INCOMPLETE;
