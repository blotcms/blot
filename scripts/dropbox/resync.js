// Resync Dropbox blogs by walking folder structure and performing a full reset
// Usage: node scripts/dropbox/resync.js [blog-identifier]

const { promisify } = require("util");
const eachBlogOrOneBlog = require("../each/eachBlogOrOneBlog");
const resetToBlot = require("clients/dropbox/sync/reset-to-blot");
const establishSyncLock = require("sync/establishSyncLock");
const fix = promisify(require("sync/fix"));

const PROGRESS_INTERVAL_MS = 30000;

let totalDropboxBlogs = 0;
let successfulResyncs = 0;
let failedResyncs = 0;
const errors = [];
let progressInterval;

const formatError = (err) => {
  if (!err) return "Unknown error";
  if (err.message) return err.message;
  return String(err);
};

const logProgress = () => {
  console.log(
    `INFO: Dropbox resync progress: ${totalDropboxBlogs} processed, ${successfulResyncs} successful, ${failedResyncs} failed`
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
  if (!blog || blog.isDisabled) return;
  if (blog.client !== "dropbox") return;

  totalDropboxBlogs++;

  const publish = (...args) => {
    console.log(`Dropbox resync ${blog.title || "Untitled"} ${blog.id}:`, ...args);
  };

  console.log(
    `INFO: Starting Dropbox resync for ${blog.id} (${blog.handle || "no handle"})`
  );

  let folder;
  let done;

  try {
    const syncLock = await establishSyncLock(blog.id);
    folder = syncLock.folder;
    done = syncLock.done;

    try {
      folder.status("Dropbox resyncing");

      await resetToBlot(blog.id, publish, folder.update);
      try {
        await fix(blog);
      } catch (err) {
        console.error(
          `WARN: Dropbox resync fix failed for ${blog.id}: ${formatError(err)}`
        );
      }
      successfulResyncs++;
      console.log(
        `SUCCESS: Completed Dropbox resync for ${blog.id} (${blog.handle || "no handle"})`
      );
    } catch (err) {
      failedResyncs++;
      const message = formatError(err);
      console.error(
        `ERROR: Dropbox resync failed for ${blog.id} (${blog.handle || "no handle"}):`,
        message
      );
      errors.push({
        blogID: blog.id,
        handle: blog.handle,
        error: message,
        step: "resync",
      });
    } finally {
      if (done) {
        try {
          await done();
        } catch (err) {
          console.error(
            `WARN: Dropbox resync failed to release sync lock for ${blog.id}: ${formatError(err)}`
          );
        }
      }
    }
  } catch (err) {
    failedResyncs++;
    const message = formatError(err);
    console.error(
      `ERROR: Dropbox resync failed to acquire lock for ${blog.id} (${blog.handle || "no handle"}):`,
      message
    );
    errors.push({
      blogID: blog.id,
      handle: blog.handle,
      error: message,
      step: "acquire lock",
    });
  }
};

const summarize = () => {
  console.log(`\n${"=".repeat(60)}`);
  console.log("Dropbox resync summary:");
  console.log(`  Total Dropbox blogs processed: ${totalDropboxBlogs}`);
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
    console.log("\nWARN: Some Dropbox resyncs failed. Review errors above.");
  } else if (totalDropboxBlogs > 0) {
    console.log("\nSUCCESS: All Dropbox blogs resynced successfully.");
  } else {
    console.log("\nINFO: No Dropbox blogs were processed.");
  }
};

if (require.main === module) {
  const identifier = process.argv[2];

  if (identifier) {
    console.log(`Resyncing Dropbox blog: ${identifier}\n`);
  } else {
    console.log("Starting Dropbox resync for all Dropbox blogs...");
    console.log("Iterating over all blogs in series...\n");
  }

  startProgress();

  eachBlogOrOneBlog(processBlog)
    .then(() => {
      stopProgress();
      summarize();
      process.exit(failedResyncs > 0 ? 1 : 0);
    })
    .catch((err) => {
      stopProgress();
      console.error("ERROR: Dropbox resync failed:", err.message || err);
      process.exit(1);
    });
}

module.exports = processBlog;
