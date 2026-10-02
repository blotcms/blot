const scheduler = require("node-schedule");
const { promisify } = require("util");
const Blog = require("models/blog");
const clfdate = require("helper/clfdate");
const Fix = require("sync/fix");
const database = require("./database");

const getBlog = promisify(Blog.get);
const getStatuses = promisify(Blog.getStatuses);

const ONE_HOUR_IN_MS = 60 * 60 * 1000;

// Google Drive used to run a full Fix() after every sync. Fix() does many
// sequential Redis round trips over the shared connection, and running it
// that often starved folder lock heartbeats until a lease expired and the
// process crashed. Like Dropbox and iCloud, run it hourly instead, outside
// the folder lock, for blogs that synced in the last hour.

// Every locked sync publishes a "Syncing"/"Synced" status, so the latest
// status is when the blog last synced - same check as iCloud's init.js.
const hasRecentSync = async (blogID) => {
  const { statuses } = await getStatuses(blogID, { pageSize: 1 });
  const lastSync = statuses && statuses[0] && statuses[0].datestamp;
  return !!lastSync && Date.now() - lastSync <= ONE_HOUR_IN_MS;
};

const fixBlog = (blog) =>
  new Promise((resolve) => {
    Fix(blog, { source: "google-drive-hourly" }, (err) => {
      if (err) {
        console.error(clfdate(), "Google Drive: Fix error for blog", blog.id, err);
      }
      resolve();
    });
  });

const fixRecentlySyncedBlogs = async () => {
  console.log(clfdate(), "Google Drive: Running hourly fix");

  let checked = 0;

  await database.blog.iterate(async (blogID, account) => {
    try {
      // Setup is still building the folder
      if (!account.folderId || account.preparing) return;

      const blog = await getBlog({ id: blogID });
      if (!blog || blog.client !== "google-drive") return;
      if (!(await hasRecentSync(blogID))) return;

      await fixBlog(blog);
      checked += 1;
    } catch (err) {
      console.error(clfdate(), "Google Drive: Error fixing blog", blogID, err);
    }
  });

  console.log(clfdate(), "Google Drive: Hourly fix complete", `checked=${checked}`);
};

let running = false;

const runHourlyFix = async () => {
  if (running) {
    console.log(clfdate(), "Google Drive: Hourly fix still running, skipping");
    return;
  }

  running = true;

  try {
    await fixRecentlySyncedBlogs();
  } catch (err) {
    console.error(clfdate(), "Google Drive: Hourly fix failed", err);
  } finally {
    running = false;
  }
};

module.exports = function scheduleHourlyFix() {
  console.log(clfdate(), "Google Drive: Scheduling hourly fix");
  // :30 so it doesn't overlap Dropbox's :00 validation
  scheduler.scheduleJob("30 * * * *", runHourlyFix);
};

// Exposed for tests
module.exports.runHourlyFix = runHourlyFix;
