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
// Fix() runs outside the sync lock, as in the hourly sweep: on a large blog
// its sequential Redis calls can starve the lock's heartbeat until the lease
// expires and the process crashes. Disabled blogs are skipped, as are accounts
// the hourly sweep wouldn't check: setup unfinished (no folder or service
// account yet, or still preparing) or a stored error such as a trashed or
// inaccessible folder. For every blog Fix() repaired, the check names and the
// number of rows each returned are printed.
//
// Usage:
//   docker exec -it blot-container-green node scripts/google-drive/fix.js
//   docker exec -it blot-container-green node scripts/google-drive/fix.js <id|handle>
//
// With no argument it asks before processing all blogs.

const { promisify } = require("util");
const eachBlogOrOneBlog = require("../each/eachBlogOrOneBlog");
const database = require("clients/google-drive/database");
const { classify } = require("clients/google-drive/database/error");
const Fix = require("sync/fix");
const getBlog = promisify(require("models/blog").get);

const PROGRESS_INTERVAL_MS = 30000;

// Same test as the hourly sweep (clients/google-drive/validate.js): setup
// builds the folder while it runs, and a stored error means the account
// can't be used until the user or the client clears it.
const isEligible = (account) =>
  Boolean(
    account &&
      account.folderId &&
      account.serviceAccountId &&
      !account.preparing &&
      !classify(account)
  );

let checkedBlogs = 0;
let repairedBlogs = 0;
let failedBlogs = 0;
const rowsPerCheck = {};
const errors = [];
let progressInterval;

const formatError = (err) => {
  if (!err) return "Unknown error";
  if (err.message) return err.message;
  return String(err);
};

// Fix() can fail part way through and still return the repairs it made
// before that, so resolve with both.
const fixBlog = (blog) =>
  new Promise((resolve) => {
    Fix(blog, (error, report) => resolve({ error, report }));
  });

const logProgress = () => {
  console.log(
    `INFO: Google Drive fix progress: ${checkedBlogs} checked, ${repairedBlogs} repaired, ${failedBlogs} failed`
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

  try {
    if (!isEligible(await database.blog.get(blog.id))) {
      console.log(
        `INFO: Skipping Google Drive blog not set up or with a stored error: ${blog.id}`
      );
      return;
    }

    // Fix() persists parts of the blog it is handed (menu-ghosts writes
    // blog.menu), so hand it the current copy.
    const current = await getBlog({ id: blog.id });
    if (!current) return;

    console.log(
      `INFO: Starting Google Drive fix for ${blog.id} (${blog.handle || "no handle"})`
    );

    checkedBlogs++;

    const { error, report } = await fixBlog(current);
    const checks = Object.keys(report || {});

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

    if (error) throw error;

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
  }
};

const summarize = () => {
  console.log(`\n${"=".repeat(60)}`);
  console.log("Google Drive fix summary:");
  console.log(`  Google Drive blogs checked: ${checkedBlogs}`);
  console.log(`  Blogs repaired: ${repairedBlogs}`);
  console.log(`  Failed: ${failedBlogs}`);

  const checks = Object.keys(rowsPerCheck);

  if (checks.length > 0) {
    console.log("\nRows repaired per check:");
    checks.forEach((check) => {
      console.log(`  ${check}: ${rowsPerCheck[check]}`);
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
      process.exit(failedBlogs > 0 ? 1 : 0);
    })
    .catch((err) => {
      stopProgress();
      console.error("ERROR: Google Drive fix failed:", err);
      process.exit(1);
    });
}
