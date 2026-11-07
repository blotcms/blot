const eachBlogOrOneBlog = require("../each/eachBlogOrOneBlog");
const fromiCloud = require("clients/icloud/sync/fromiCloud");
const establishSyncLock = require("sync/establishSyncLock");
const database = require("clients/icloud/database");
const fix = require("sync/fix");

const PROGRESS_INTERVAL_MS = 30000;

let totalIcloudBlogs = 0;
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
    `INFO: iCloud resync progress: ${totalIcloudBlogs} processed, ${successfulResyncs} successful, ${failedResyncs} failed`
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
  if (blog.client !== "icloud") return;

  console.log(
    `INFO: Starting iCloud resync for ${blog.id} (${blog.handle || "no handle"})`
  );

  let folder;
  let done;

  try {
    const account = await database.get(blog.id);

    if (account.setupComplete !== true) {
      console.log(`INFO: Skipping iCloud blog not setupComplete: ${blog.id}`);
      return;
    }

    totalIcloudBlogs++;

    const syncLock = await establishSyncLock(blog.id);
    folder = syncLock.folder;
    done = syncLock.done;

    await fromiCloud(blog.id, folder.status, folder.update);

    try {
      await fix(blog);
    } catch (err) {
      console.error(
        `WARN: iCloud resync fix failed for ${blog.id}: ${formatError(err)}`
      );
    }

    successfulResyncs++;
    console.log(
      `SUCCESS: Completed iCloud resync for ${blog.id} (${blog.handle || "no handle"})`
    );
  } catch (err) {
    failedResyncs++;
    const message = formatError(err);
    console.error(
      `ERROR: iCloud resync failed for ${blog.id} (${blog.handle || "no handle"}):`,
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
          `WARN: iCloud resync failed to release sync lock for ${blog.id}: ${formatError(
            err
          )}`
        );
      }
    }
  }
};

const summarize = () => {
  console.log(`\n${"=".repeat(60)}`);
  console.log("iCloud resync summary:");
  console.log(`  Total iCloud blogs processed: ${totalIcloudBlogs}`);
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
    console.log("\nWARN: Some iCloud resyncs failed. Review errors above.");
  } else if (totalIcloudBlogs > 0) {
    console.log("\nSUCCESS: All iCloud blogs resynced successfully.");
  } else {
    console.log("\nINFO: No iCloud blogs were processed.");
  }
};

if (require.main === module) {
  startProgress();

  eachBlogOrOneBlog(processBlog)
    .then(() => {
      stopProgress();
      summarize();
      process.exit(failedResyncs > 0 ? 1 : 0);
    })
    .catch((err) => {
      stopProgress();
      console.error("ERROR: iCloud resync failed:", err);
      process.exit(1);
    });
}
