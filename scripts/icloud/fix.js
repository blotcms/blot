// Runs sync/fix's Fix() once on every blog connected to iCloud, without
// walking iCloud.
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
// can be run again. Disabled blogs and iCloud accounts whose setup isn't
// complete are skipped. For every blog Fix() repaired, the check names and
// the number of rows each returned are printed.
//
// Usage:
//   docker exec -it blot-container-green node scripts/icloud/fix.js
//   docker exec -it blot-container-green node scripts/icloud/fix.js <id|handle>
//
// With no argument it asks before processing all blogs.

const { promisify } = require("util");
const eachBlogOrOneBlog = require("../each/eachBlogOrOneBlog");
const establishSyncLock = require("sync/establishSyncLock");
const database = require("clients/icloud/database");
const fix = promisify(require("sync/fix"));
const getBlog = promisify(require("models/blog").get);

const PROGRESS_INTERVAL_MS = 30000;

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
    `INFO: iCloud fix progress: ${checkedBlogs} checked, ${skippedBlogs} skipped, ${repairedBlogs} repaired, ${failedBlogs} failed`
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
  if (blog.client !== "icloud" || blog.isDisabled) return;

  let done;

  try {
    const account = await database.get(blog.id);

    if (!account || account.setupComplete !== true) {
      console.log(`INFO: Skipping iCloud blog not setupComplete: ${blog.id}`);
      return;
    }

    console.log(
      `INFO: Starting iCloud fix for ${blog.id} (${blog.handle || "no handle"})`
    );

    let syncLock;

    try {
      syncLock = await establishSyncLock(blog.id);
    } catch (err) {
      skippedBlogs++;
      skipped.push({ blogID: blog.id, handle: blog.handle });
      console.error(
        `WARN: iCloud fix skipped ${blog.id} (${blog.handle || "no handle"}), could not take the sync lock: ${formatError(
          err
        )}`
      );
      return;
    }

    done = syncLock.done;

    // A sync we waited on may have changed the blog (e.g. its menu), and
    // Fix() writes the menu back whole, so use the current copy.
    const current = await getBlog({ id: blog.id });
    if (!current) return;

    checkedBlogs++;

    const report = (await fix(current)) || {};
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
      `SUCCESS: Completed iCloud fix for ${blog.id} (${blog.handle || "no handle"})`
    );
  } catch (err) {
    failedBlogs++;
    const message = formatError(err);
    console.error(
      `ERROR: iCloud fix failed for ${blog.id} (${blog.handle || "no handle"}):`,
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
          `WARN: iCloud fix failed to release sync lock for ${blog.id}: ${formatError(
            err
          )}`
        );
      }
    }
  }
};

const summarize = () => {
  console.log(`\n${"=".repeat(60)}`);
  console.log("iCloud fix summary:");
  console.log(`  iCloud blogs checked: ${checkedBlogs}`);
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
    console.log("\nWARN: Fix() failed on some iCloud blogs. Review errors above.");
  } else if (skippedBlogs > 0) {
    console.log("\nWARN: Some iCloud blogs were skipped. Run the script again.");
  } else if (checkedBlogs > 0) {
    console.log("\nSUCCESS: Fix() ran on all iCloud blogs.");
  } else {
    console.log("\nINFO: No iCloud blogs were checked.");
  }
};

if (require.main === module) {
  startProgress();

  eachBlogOrOneBlog(processBlog)
    .then(() => {
      stopProgress();
      summarize();
      process.exit(failedBlogs > 0 ? 1 : 0);
    })
    .catch((err) => {
      stopProgress();
      console.error("ERROR: iCloud fix failed:", err);
      process.exit(1);
    });
}
