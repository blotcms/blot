// Resync Google Drive blogs by walking the folder structure and performing a full reset
// Usage: node scripts/google-drive/resync.js [blog-identifier]

const eachBlogOrOneBlog = require("../each/eachBlogOrOneBlog");
const resetFromDrive = require("clients/google-drive/sync/resetFromDrive");
const establishSyncLock = require("sync/establishSyncLock");

let totalGoogleDriveBlogs = 0;
let successfulResyncs = 0;
let failedResyncs = 0;
const errors = [];

const processBlog = async (blog) => {
  if (!blog || blog.isDisabled) return;
  if (blog.client !== "google-drive") return;

  totalGoogleDriveBlogs++;

  console.log(
    `Starting Google Drive resync for ${blog.id} (${blog.handle || "no handle"})`
  );

  const recordFailure = (message) => {
    failedResyncs++;
    console.error(
      `❌ Google Drive resync failed for ${blog.id} (${blog.handle || "no handle"}):`,
      message
    );
    errors.push({
      blogID: blog.id,
      handle: blog.handle,
      error: message,
    });
  };

  let syncLock;

  try {
    syncLock = await establishSyncLock(blog.id);
  } catch (err) {
    const message = err && err.message ? err.message : err;
    recordFailure(`Could not acquire sync lock: ${message}`);
  }

  if (syncLock) {
    const { folder, done } = syncLock;

    try {
      // Hold the folder lock for the whole walk so a webhook-triggered sync
      // can't race it, and pass folder.update so changed files get rebuilt.
      const summary = await resetFromDrive(
        blog.id,
        folder.status,
        folder.update
      );

      if (!summary) {
        recordFailure("Sync did not finish walking the Drive folder");
      } else {
        successfulResyncs++;
        console.log(
          `✅ Completed Google Drive resync for ${blog.id} (${blog.handle || "no handle"})`
        );
      }
    } catch (err) {
      recordFailure(err && err.message ? err.message : err);
    } finally {
      try {
        await done();
      } catch (err) {
        console.warn(
          `⚠️  Google Drive resync failed to release sync lock for ${blog.id}:`,
          err && err.message ? err.message : err
        );
      }
    }
  }

  if (totalGoogleDriveBlogs % 50 === 0) {
    console.log(
      `Progress: ${totalGoogleDriveBlogs} Google Drive blog${
        totalGoogleDriveBlogs !== 1 ? "s" : ""
      } processed, ${successfulResyncs} successful, ${failedResyncs} failed...`
    );
  }
};

const summarize = () => {
  console.log(`\n${"=".repeat(60)}`);
  console.log("Google Drive resync summary:");
  console.log(`  Total Google Drive blogs processed: ${totalGoogleDriveBlogs}`);
  console.log(`  Successful resyncs: ${successfulResyncs}`);
  console.log(`  Failed resyncs: ${failedResyncs}`);

  if (errors.length > 0) {
    console.log("\nErrors:");
    errors.slice(0, 10).forEach((error) => {
      console.log(
        `  Blog ${error.blogID} (${error.handle || "no handle"}): ${error.error}`
      );
    });
    if (errors.length > 10) {
      console.log(`  ... and ${errors.length - 10} more errors`);
    }
  }

  if (failedResyncs > 0) {
    console.log("\n⚠️  Some Google Drive resyncs failed. Review errors above.");
  } else if (totalGoogleDriveBlogs > 0) {
    console.log("\n✅ All Google Drive blogs resynced successfully!");
  } else {
    console.log("\nℹ️  No Google Drive blogs were processed.");
  }
};

if (require.main === module) {
  const identifier = process.argv[2];

  if (identifier) {
    console.log(`Resyncing Google Drive blog: ${identifier}\n`);
  } else {
    console.log("Starting Google Drive resync for all Google Drive blogs...");
    console.log("Iterating over all blogs in series...\n");
  }

  eachBlogOrOneBlog(processBlog)
    .then(() => {
      summarize();
      process.exit(failedResyncs > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error("Google Drive resync failed:", err.message || err);
      process.exit(1);
    });
}

module.exports = processBlog;
