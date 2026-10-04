const scheduler = require("node-schedule");
const { promisify } = require("util");
const Blog = require("models/blog");
const clfdate = require("helper/clfdate");
const email = require("helper/email");
const monitorMacServerStats = require("./util/monitorMacServerStats");
const establishSyncLock = require("sync/establishSyncLock");
const initialTransfer = require("./sync/initialTransfer");
const database = require("./database");
const syncFromiCloud = require("./sync/fromiCloud");
const syncToiCloud = require("./sync/toiCloud");
const Fix = require("sync/fix");

const getBlog = promisify(Blog.get);

const ONE_HOUR_IN_MS = 60 * 60 * 1000;
const RESYNC_WINDOW = 1000 * 60 * 10; // 10 minutes

const countChanges = (summary = {}) => {
  return (
    (summary.downloaded || 0) +
    (summary.removed || 0) +
    (summary.createdDirs || 0)
  );
};

const getLastSyncDateStamp = (blogID) => {
  return new Promise((resolve, reject) => {
    Blog.getStatuses(blogID, { pageSize: 1 }, (err, res) => {
      if (err) return reject(err);

      const statuses = res.statuses;

      if (!statuses || statuses.length === 0) {
        return resolve(null);
      }
      resolve(statuses[0].datestamp);
    });
  });
};

const resyncRecentlySynced = async (options = {}) => {
  const windowMs =
    typeof options.windowMs === "number" ? options.windowMs : RESYNC_WINDOW;
  const notify = options.notify !== undefined ? options.notify : false;
  const resyncContext = notify ? "hourly validation" : "startup resync";

  console.log(
    clfdate(),
    "Resyncing recently synced blogs",
    `(${resyncContext})`
  );

  await database.iterate(async (blogID, account) => {
    if (!account.setupComplete) {
      console.log(
        clfdate(),
        "Account setup not complete, skipping resync: ",
        blogID
      );
      return;
    }

    const lastSync = await getLastSyncDateStamp(blogID);

    if (!lastSync) {
      console.log(clfdate(), "No last sync date found for blogID: ", blogID);
      return;
    }

    const minutesAgo = Math.floor((Date.now() - lastSync) / 1000 / 60);

    // if the blog last synced within the last 10 minutes, we want to resync
    // because we might have missed some events
    if (Date.now() - lastSync < windowMs) {
      console.log(clfdate(), "Resyncing blog: ", blogID);

      // Ensure the hourly sync check is always gated by the sync
      // lock to prevent files from being removed from Blot 
      // during an initial setup. This prevents data loss.
      let folder;
      let done;

      try {
        ({ folder, done } = await establishSyncLock(blogID));
      } catch (error) {
        console.warn(
          clfdate(),
          "Blog is currently syncing elsewhere, skipping resync:",
          blogID
        );
        return;
      }
      try {
        // We don't sync to iCloud here because we want to respect
        // the state of the iCloud folder. It's possible that Blot
        // has made some folder changes which are unsynced but we 
        // prefer to destroy those rather than re-upload files
        // which were deleted on iCloud.
        await syncFromiCloud(blogID, folder.status, folder.update);
        console.log(clfdate(), "Finished resyncing blog: ", blogID);
      } catch (error) {
        console.error(clfdate(), "Error resyncing blog: ", blogID, error);
      } finally {
        await done();
      }
    } else {
      console.log(
        clfdate(),
        "Skipping resync of blog which last synced",
        minutesAgo,
        "minutes ago"
      );
    }
  });

  console.log(
    clfdate(),
    "Finished resyncing recently synced blogs",
    `(${resyncContext})`
  );
};

const hasRecentSync = async (blogID) => {
  const lastSync = await getLastSyncDateStamp(blogID);
  if (!lastSync) return false;
  return Date.now() - lastSync <= ONE_HOUR_IN_MS;
};

const runValidation = async ({ notify = true } = {}) => {
  console.log(clfdate(), "iCloud: Running hourly sync validation");

  const blogsWithChanges = [];
  let checkedBlogs = 0;

  try {
    await database.iterate(async (blogID, account) => {
      try {
        const blog = await getBlog({ id: blogID });
        if (!blog || blog.client !== "icloud") return;

        if (!(await hasRecentSync(blogID))) return;

        checkedBlogs += 1;

        const publish = (...args) => {
          console.log(clfdate(), "iCloud:", blogID, ...args);
        };

        // Ensure the hourly sync check is always gated by the sync
        // lock to prevent files from being removed from Blot 
        // during an initial setup. This prevents data loss.
        const { folder, done } = await establishSyncLock(blogID);
        let summary;

        try {
          summary = await syncFromiCloud(blogID, publish, folder.update);
        } finally {
          await done();
        }

        const changeCount = countChanges(summary);

        if (changeCount > 0) {
          blogsWithChanges.push({
            id: blogID,
            handle: blog.handle,
            truncatedId: blogID.slice(0, 12),
            changeCount,
            changeCountPlural: changeCount !== 1,
            downloaded: summary.downloaded || 0,
            removed: summary.removed || 0,
            createdDirs: summary.createdDirs || 0
          });
        }

        await new Promise((resolve) => {
          Fix(blog, (fixError) => {
            if (fixError) {
              console.error(
                clfdate(),
                "iCloud: Fix error for blog",
                blogID,
                fixError
              );
            }
            resolve();
          });
        });
      } catch (error) {
        console.error(
          clfdate(),
          "iCloud: Error validating sync for blog",
          blogID,
          error
        );
      }
    });
  } catch (error) {
    console.error(clfdate(), "iCloud: Failed to iterate accounts", error);
    return;
  }

  console.log(
    clfdate(),
    "iCloud: Sync validation complete",
    `checked=${checkedBlogs}`,
    `issues=${blogsWithChanges.length}`
  );

  if (!notify || blogsWithChanges.length === 0) return;

  email.ICLOUD_SYNC_ISSUE(null, { blogs: blogsWithChanges }, function (err) {
    if (err) {
      console.error(clfdate(), "iCloud: Failed to send issue email", err);
    } else {
      console.log(clfdate(), "iCloud: Sent sync issue report email");
    }
  });
};

const resyncAllConnected = async ({ notify = true } = {}) => {
  console.log(clfdate(), "iCloud: Running daily resync for connected accounts");

  const blogsWithChanges = [];
  let checkedBlogs = 0;

  try {
    await database.iterate(async (blogID, account) => {
      if (!account.setupComplete) {
        console.log(
          clfdate(),
          "iCloud: Daily resync skipped (setup incomplete)",
          blogID
        );
        return;
      }

      if (account.error) {
        console.log(
          clfdate(),
          "iCloud: Daily resync skipped (account error)",
          blogID,
          account.error
        );
        return;
      }

      try {
        const blog = await getBlog({ id: blogID });
        if (!blog || blog.client !== "icloud") return;

        checkedBlogs += 1;

        const publish = (...args) => {
          console.log(clfdate(), "iCloud: Daily resync", blogID, ...args);
        };

        let folder;
        let done;

        try {
          ({ folder, done } = await establishSyncLock(blogID));
        } catch (error) {
          console.warn(
            clfdate(),
            "iCloud: Daily resync skipped (already syncing)",
            blogID
          );
          return;
        }

        let summary;

        try {
          summary = await syncFromiCloud(blogID, folder.status, folder.update);
        } catch (error) {
          console.error(
            clfdate(),
            "iCloud: Error during daily resync for blog",
            blogID,
            error
          );
        } finally {
          await done();
        }

        if (!summary) return;

        const changeCount = countChanges(summary);

        if (changeCount > 0) {
          blogsWithChanges.push({
            id: blogID,
            handle: blog.handle,
            truncatedId: blogID.slice(0, 12),
            changeCount,
            changeCountPlural: changeCount !== 1,
            downloaded: summary.downloaded || 0,
            removed: summary.removed || 0,
            createdDirs: summary.createdDirs || 0
          });
        }
      } catch (error) {
        console.error(
          clfdate(),
          "iCloud: Error iterating daily resync for blog",
          blogID,
          error
        );
      }
    });
  } catch (error) {
    console.error(clfdate(), "iCloud: Failed to iterate accounts", error);
    return;
  }

  console.log(
    clfdate(),
    "iCloud: Daily resync complete",
    `checked=${checkedBlogs}`,
    `issues=${blogsWithChanges.length}`
  );

  if (!notify || blogsWithChanges.length === 0) return;

  email.ICLOUD_SYNC_ISSUE(null, { blogs: blogsWithChanges }, function (err) {
    if (err) {
      console.error(
        clfdate(),
        "iCloud: Failed to send daily resync issue email",
        err
      );
    } else {
      console.log(clfdate(), "iCloud: Sent daily resync issue report email");
    }
  });
};

const init = async () => {

  await database.iterate(async (blogID, account) => {
    if (!account.transferringToiCloud) {
      return;
    }

    try {
      console.log("Resuming initial transfer for", blogID);
      await initialTransfer(blogID);
    } catch (error) {
      console.error("Error resuming initial transfer for", blogID, error);
    }
  });

  console.log(clfdate(), "iCloud: Scheduling hourly sync validation");
  // scheduler.scheduleJob("0 * * * *", () => runValidation({ notify: true }));

  console.log(clfdate(), "iCloud: Scheduling daily resync");
  // scheduler.scheduleJob("0 3 * * *", () => resyncAllConnected({ notify: true }));

  // resyncRecentlySynced({ notify: false });

  monitorMacServerStats();
};

init.resyncRecentlySynced = resyncRecentlySynced;
init.resyncAllConnected = resyncAllConnected;

module.exports = init;
