// Runs sync/fix's Fix() once on every blog connected to Google Drive, without
// walking Google Drive.
//
// Run once after deploying commit 3e6433ef2 ("Sync walks: update every path
// inside a folder they remove"). Before it, a walk that removed a local folder
// didn't drop the entries inside it, leaving "entry ghosts" (live entries with
// no file on disk). A resync walk can't see them; only Fix()'s entry-ghosts
// check clears them, and Fix() only runs on the hourly sweep for blogs that
// synced recently. This is one quiet pass to clear the backlog.
//
// Each blog is fixed under its sync lock. A blog whose lock can't be had (it
// is syncing) is skipped with a WARN and listed in the summary, so the script
// can be run again. Disabled blogs are skipped, as are accounts the hourly
// sweep wouldn't walk: setup unfinished (no folder or service account yet, or
// still preparing) or a stored error such as a trashed or inaccessible
// folder. For every blog Fix() repaired, the check names and the number of
// rows each returned are printed.
//
// Usage:
//   docker exec -it blot-container-green node scripts/google-drive/fix.js
//   docker exec -it blot-container-green node scripts/google-drive/fix.js <id|handle>
//
// With no argument it asks before processing all blogs.

const { promisify } = require("util");
const eachBlogOrOneBlog = require("../each/eachBlogOrOneBlog");
const establishSyncLock = require("sync/establishSyncLock");
const database = require("clients/google-drive/database");
const { classify } = require("clients/google-drive/database/error");
const fix = promisify(require("sync/fix"));

const PROGRESS_INTERVAL_MS = 30000;

// Same test as the hourly sweep (clients/google-drive/validate.js): setup
// holds the folder lock while it builds the folder, and a stored error means
// the account can't be used until the user or the client clears it.
const isEligible = (account) =>
  Boolean(
    account &&
      account.folderId &&
      account.serviceAccountId &&
      !account.preparing &&
      !classify(account)
  );

let checkedBlogs = 0;
let skippedBlogs = 0;
let repairedBlogs = 0;
let failedBlogs = 0;
const rowsPerCheck = {};
const skipped = [];
const errors = [];
let progressInterval;

const formatError = (err) => {
  if (!err) return "Unknown error";
  if (err.message) return err.message;
  return String(err);
};

const logProgress = () => {
  console.log(
    `INFO: Google Drive fix progress: ${checkedBlogs} checked, ${skippedBlogs} skipped, ${repairedBlogs} repaired, ${failedBlogs} failed`
  );
};

const startProgress = () => {
  progressInterval = setInterval(logProgress, PROGRESS_INTERVAL_MS);
  if (progressInterval.unref) progressInterval.unref();
};

const stopProgress = () => {
  if (progressInterval) clearInterval(progressInterval);
};

const processBlog = async (blog) => {
  if (blog.client !== "google-drive" || blog.isDisabled) return;

  let done;

  try {
    if (!isEligible(await database.blog.get(blog.id))) {
      console.log(
        `INFO: Skipping Google Drive blog not set up or with a stored error: ${blog.id}`
      );
      return;
    }

    console.log(
      `INFO: Starting Google Drive fix for ${blog.id} (${blog.handle || "no handle"})`
    );

    let syncLock;

    try {
      syncLock = await establishSyncLock(blog.id);
    } catch (err) {
      skippedBlogs++;
      skipped.push({ blogID: blog.id, handle: blog.handle });
      console.error(
        `WARN: Google Drive fix skipped ${blog.id} (${blog.handle || "no handle"}), could not take the sync lock: ${formatError(
          err
        )}`
      );
      return;
    }

    done = syncLock.done;

    // Setup or a stored error can have started while we waited for the lock.
    if (!isEligible(await database.blog.get(blog.id))) {
      console.log(
        `INFO: Skipping Google Drive blog, no longer eligible: ${blog.id}`
      );
      return;
    }

    checkedBlogs++;

    const report = (await fix(blog)) || {};
    const checks = Object.keys(report);

    if (checks.length > 0) {
      repairedBlogs++;
      console.log(
        `INFO: Fix() repaired ${blog.id} (${blog.handle || "no handle"})`
      );
      checks.forEach((check) => {
        const rows = report[check].length;
        rowsPerCheck[check] = (rowsPerCheck[check] || 0) + rows;
        console.log(`INFO:   ${check}: ${rows} row${rows === 1 ? "" : "s"}`);
      });
    }

    console.log(
      `SUCCESS: Completed Google Drive fix for ${blog.id} (${blog.handle || "no handle"})`
    );
  } catch (err) {
    failedBlogs++;
    const message = formatError(err);
    console.error(
      `ERROR: Google Drive fix failed for ${blog.id} (${blog.handle || "no handle"}):`,
      message
    );
    errors.push({
      blogID: blog.id,
      handle: blog.handle,
      error: message,
    });
  } finally {
    if (done) {
      try {
        await done();
      } catch (err) {
        console.error(
          `WARN: Google Drive fix failed to release sync lock for ${blog.id}: ${formatError(
            err
          )}`
        );
      }
    }
  }
};

const summarize = () => {
  console.log(`\n${"=".repeat(60)}`);
  console.log("Google Drive fix summary:");
  console.log(`  Google Drive blogs checked: ${checkedBlogs}`);
  console.log(`  Skipped (sync lock busy): ${skippedBlogs}`);
  console.log(`  Blogs repaired: ${repairedBlogs}`);
  console.log(`  Failed: ${failedBlogs}`);

  const checks = Object.keys(rowsPerCheck);

  if (checks.length > 0) {
    console.log("\nRows repaired per check:");
    checks.forEach((check) => {
      console.log(`  ${check}: ${rowsPerCheck[check]}`);
    });
  }

  if (skipped.length > 0) {
    console.log("\nSkipped (run again to cover them):");
    skipped.forEach((blog) => {
      console.log(`  Blog ${blog.blogID} (${blog.handle || "no handle"})`);
    });
  }

  if (errors.length > 0) {
    console.log("\nErrors:");
    errors.forEach((error) => {
      console.log(
        `  Blog ${error.blogID} (${error.handle || "no handle"}): ${error.error}`
      );
    });
  }

  if (failedBlogs > 0) {
    console.log("\nWARN: Fix() failed on some Google Drive blogs. Review errors above.");
  } else if (skippedBlogs > 0) {
    console.log("\nWARN: Some Google Drive blogs were skipped. Run the script again.");
  } else if (checkedBlogs > 0) {
    console.log("\nSUCCESS: Fix() ran on all Google Drive blogs.");
  } else {
    console.log("\nINFO: No Google Drive blogs were checked.");
  }
};

if (require.main === module) {
  startProgress();

  eachBlogOrOneBlog(processBlog)
    .then(() => {
      stopProgress();
      summarize();
      process.exit(0);
    })
    .catch((err) => {
      stopProgress();
      console.error("ERROR: Google Drive fix failed:", err);
      process.exit(1);
    });
}
