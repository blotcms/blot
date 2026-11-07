// Development only (see README): sets up a blog on the Local client.
const fs = require("fs-extra");
const Blog = require("models/blog");
const config = require("config");
const Fix = require("sync/fix");
const syncReport = require("clients/util/syncReport");
const establishSyncLock = require("sync/establishSyncLock");
const clfdate = require("helper/clfdate");
const source = require("./source");
const { reconcile, seed } = require("./sync");
const watch = require("./watch");
const prefix = () => clfdate() + " Local folder client:";

// Brings the blog's folder in line with its source directory, creating the
// directory first for a blog which has none (see README, "Existing blogs").
// Resolves the directory.
async function reconcileSource(blogID, dir) {
  dir = dir || (await source.directory(blogID));

  if (!(await fs.pathExists(dir))) {
    const copied = await seed(blogID, dir);
    console.log(
      prefix(),
      "Copied",
      copied,
      "files of the folder of",
      blogID,
      "to its new source directory",
      dir
    );
    return dir;
  }

  // The lock is taken before anything in the folder changes, and held until
  // every changed path is updated. If it can't be taken, nothing was touched.
  const { folder, done } = await establishSyncLock(blogID);
  const changed = [];
  let failure;

  try {
    try {
      await reconcile(blogID, dir, changed);
    } catch (err) {
      failure = err;
    }

    // Even after a failure, whatever was applied gets its entries updated
    for (const path of new Set(changed)) {
      try {
        await folder.update(path);
      } catch (err) {
        if (!failure) failure = err;
      }
    }
  } finally {
    await done(failure || null);
  }

  if (changed.length) {
    console.log(
      prefix(),
      "Reconciled",
      blogID,
      "with",
      dir + ":",
      changed.length,
      "changes"
    );
  }

  if (failure) throw failure;
  return dir;
}

// Always resolves: a blog which can't be loaded or fixed, or a source which
// can't be set up, is logged and left as it is.
async function setup(blogID) {
  let blog;

  try {
    blog = await Blog.get({ id: blogID });
  } catch (err) {
    return;
  }

  if (!blog) return;

  const { err, report } = await new Promise(function (resolve) {
    Fix(blog, function (err, report) {
      resolve({ err, report });
    });
  });

  // Fix() can fail after repairing some checks, so log first.
  const repaired = syncReport.summarize(report);
  if (repaired) console.log(prefix(), "Fix repaired", blogID, repaired);
  if (err) return;
  if (config.environment === "development") {
    try {
      const dir = await reconcileSource(blogID);
      await watch(blogID, dir);
    } catch (e) {
      console.error(prefix(), "Unable to set up", blogID, e);
      return;
    }
  }
  console.log(prefix(), "Setup complete", blogID);
}

const promiseOnly = require("helper/promiseOnly");

module.exports = promiseOnly(setup);
module.exports.reconcileSource = reconcileSource;
