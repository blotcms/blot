const crypto = require("crypto");
const Blog = require("models/blog");
const clfdate = require("helper/clfdate");
const drain = require("helper/drain");
const email = require("helper/email");
const monitorMacServerStats = require("./util/monitorMacServerStats");
const resumeTransfers = require("./sync/resumeTransfers");
const database = require("./database");
const getHealth = require("./getHealth");
const { shouldSkipBackgroundSync } = require("./error");
const validateBlog = require("./sync/validateBlog");
const syncReport = require("clients/util/syncReport");
const { exclusive, schedule } = require("clients/util/scheduleExclusive");
const onceAtStartup = require("clients/util/onceAtStartup");

const ONE_HOUR_IN_MS = 60 * 60 * 1000;

// Eligible for the sweep only if the macserver pushed something in the last
// hour (routes/site stamp lastSync). Not Blog.getStatuses: taking the folder
// lock writes "Syncing"/"Synced" statuses, so the sweep itself would make
// every blog look recently synced and be re-walked every hour forever.
const hasRecentSync = (account) => {
  if (!account || typeof account.lastSync !== "number") return false;
  return Date.now() - account.lastSync <= ONE_HOUR_IN_MS;
};

// Blogs the macserver hasn't pushed to are checked too, a twenty-fourth of
// them each hour (by a hash of the blog ID), so every blog is walked once a
// day. A change the macserver missed on a quiet blog was otherwise never
// repaired: one blog kept stale versions of five files for six weeks. Spread
// across the day it is a handful of extra walks an hour, not one burst.
const IDLE_SLICES = 24;

const idleSliceOf = (blogID) =>
  parseInt(
    crypto.createHash("sha1").update(blogID).digest("hex").slice(0, 8),
    16
  ) % IDLE_SLICES;

// { idleSlice }: also walk the idle blogs in that slice (0-23); without it
// only blogs with a recent push are walked
const validateAllBlogs = async ({ idleSlice } = {}) => {
  console.log(
    clfdate(),
    "iCloud: Running hourly sync validation",
    idleSlice === undefined ? "" : `(idle slice ${idleSlice})`
  );

  const report = syncReport.create();
  let checkedBlogs = 0;
  let stopped = false;

  try {
    await database.iterate(async (blogID, account) => {
      // Every lock is refused while draining; the next hour's run covers the rest
      if (stopped || drain.isDraining()) {
        if (!stopped) {
          console.log(
            clfdate(),
            "iCloud: Stopped sync validation for the drain"
          );
        }
        stopped = true;
        return;
      }

      let blog;
      let phase = "validation";

      try {
        blog = await Blog.get({ id: blogID });
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
        // A big initial transfer can legitimately hold the lock for over an
        // hour, so a lock held during it isn't stuck.
        if (account && account.transferringToiCloud === true) return;

        if (await syncReport.recordStuckLock(report, blog)) return;

        if (shouldSkipBackgroundSync(account)) return;
        if (!hasRecentSync(account) && idleSliceOf(blogID) !== idleSlice) {
          return;
        }

        checkedBlogs += 1;

        const publish = (...args) => {
          console.log(clfdate(), "iCloud:", blogID, ...args);
        };

        // Walks under the lock and runs Fix(), recording both in the report.
        // False means it didn't get to check the blog (a lock held by a sync
        // already running, a disabled blog, or an account that became unfit
        // once the lock was held), so it doesn't count as checked.
        if (!(await validateBlog(blog, report, { publish }))) checkedBlogs -= 1;
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

// The sweep is sequential and a slow macserver can stretch it past an hour, so
// a run is skipped if one is still going in any process.
const runValidation = exclusive("icloud-validation", () =>
  validateAllBlogs({ idleSlice: new Date().getUTCHours() % IDLE_SLICES })
);

// Startup's resume does not count as done while a transfer it skipped was
// locked: that transfer may be running in a process the deploy is about to
// stop, and the next process to start in this release should try it again.
const resumeInitialTransfers = async () => {
  const busy = await resumeTransfers();
  if (busy > 0) {
    throw new Error(`${busy} initial transfer(s) locked, not marking done`);
  }
};

const init = async () => {
  // At :45 because the Dropbox sweep runs at :00 and Google Drive's at :30,
  // and all three share the Redis connection. One process runs each sweep.
  console.log(clfdate(), "iCloud: Scheduling hourly sync validation");
  schedule("icloud-validation", "45 * * * *", runValidation);

  // Startup's resume runs once per release, so a transfer killed after it
  // (the second unit of a deploy, or a crash) is picked up here instead. A
  // resume can take hours, so runs never overlap.
  schedule(
    "icloud-resume-transfers-hourly",
    "15 * * * *",
    exclusive("icloud-resume-transfers-hourly", resumeTransfers)
  );

  // Resuming can take a long time, so the sweep is scheduled first. Once per
  // deploy across all processes, not once per process.
  try {
    await onceAtStartup("icloud-resume-transfers", resumeInitialTransfers);
  } catch (error) {
    console.error(clfdate(), "iCloud: Error resuming initial transfers", error);
  }

  // Only the hourly sweep runs, and it skips idle blogs: a full resync of
  // every connected blog in one burst is a lot of load for the macserver and
  // Redis at once.

  monitorMacServerStats();
};

// Exposed for tests
init.validateAllBlogs = validateAllBlogs;
init.idleSliceOf = idleSliceOf;
init.runValidation = runValidation;
init.resumeInitialTransfers = resumeInitialTransfers;

module.exports = init;
