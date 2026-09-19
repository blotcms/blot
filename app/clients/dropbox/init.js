const scheduler = require("node-schedule");
const { promisify } = require("util");
const Blog = require("models/blog");
const clfdate = require("helper/clfdate");
const email = require("helper/email");
const resetToBlot = require("./sync/reset-to-blot");
const { get: getAccount, set: setAccount } = require("./database");
const Fix = require("sync/fix");
const establishSyncLock = require("sync/establishSyncLock");
const sync = promisify(require("./sync"));
const countChanges = require("./sync/count-changes");

const getAllIDs = promisify(Blog.getAllIDs);
const getBlog = promisify(Blog.get);
const getDropboxAccount = promisify(getAccount);
const setDropboxAccount = promisify(setAccount);

const ONE_HOUR_IN_MS = 60 * 60 * 1000;
const FIFTEEN_MINUTES_IN_MS = 15 * 60 * 1000;

// Runs resetToBlot while holding the blog's folder lock, so it can't race a
// webhook sync, then updates the database for every path it changed on disk.
// resetToBlot alone only writes files, and it advances the Dropbox cursor,
// so without this a later sync would never notice those files changed.
const resetToBlotWithLock = async (blogID, publish) => {
  const { folder, done } = await establishSyncLock(blogID);

  let summary;

  try {
    summary = await resetToBlot(blogID, publish);

    for (const path of summary.changedPaths) {
      try {
        await folder.update(path);
      } catch (err) {
        console.error(clfdate(), "Dropbox: Error updating", blogID, path, err);
      }
    }
  } catch (err) {
    // done rejects with err once the lock is released
    await done(err).catch(() => {});
    throw err;
  }

  await done(null);

  return summary;
};

// Webhook syncs that arrive while we hold the lock give up waiting for it and
// are dropped, so run a normal sync once we release it. sync() stamps
// last_sync, which would keep the blog eligible for validation forever, so
// put the previous value back.
const catchUpSync = async (blog) => {
  try {
    const before = await getDropboxAccount(blog.id);
    await sync(blog);
    if (before && typeof before.last_sync === "number") {
      await setDropboxAccount(blog.id, { last_sync: before.last_sync });
    }
  } catch (err) {
    console.error(clfdate(), "Dropbox: Catch-up sync error", blog.id, err);
  }
};

const hasRecentSync = (account) => {
  if (!account || typeof account.last_sync !== "number") return false;
  return Date.now() - account.last_sync <= ONE_HOUR_IN_MS;
};

const runValidation = async () => {
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

      let summary;

      try {
        summary = await resetToBlotWithLock(blogID, publish);
      } catch (err) {
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

      await new Promise((resolve) => {
        Fix(blog, (fixError) => {
          if (fixError) {
            console.error(
              clfdate(),
              "Dropbox: Fix error for blog",
              blogID,
              fixError
            );
          }
          resolve();
        });
      });

      await catchUpSync(blog);
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
