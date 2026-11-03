const Blog = require("models/blog");
const config = require("config");
const chokidar = require("chokidar");
const shouldIgnoreFile = require("clients/util/shouldIgnoreFile");
const folder = require("storage/folder");
const Fix = require("sync/fix");
const syncReport = require("clients/util/syncReport");
const establishSyncLock = require("sync/establishSyncLock");
const clfdate = require("helper/clfdate");
const prefix = () => clfdate() + " Local folder client:";

let watchers = {};

function setup(blogID, callback) {
  Blog.get({ id: blogID }, function (err, blog) {
    if (err || !blog) return callback();
    Fix(blog, async function (err, report) {
      // Fix() can fail after repairing some checks, so log first.
      const repaired = syncReport.summarize(report);
      if (repaired) console.log(prefix(), "Fix repaired", blogID, repaired);
      if (err) return callback();
      if (config.environment === "development") {
        await watch(blogID);
      }
      console.log(prefix(), "Setup complete", blogID);
      callback();
    });
  });
}

async function watch(blogID) {
  const debounceInterval = 50;
  const maximumBatchSize = 100;
  const pending = new Set();
  let flushTimer;
  let running = false;

  async function processBatch(paths) {
    const blog = await new Promise((resolve, reject) => {
      Blog.get({ id: blogID }, (err, blog) =>
        err ? reject(err) : resolve(blog)
      );
    });

    if (!blog || blog.client !== "local") {
      if (watchers[blogID]) {
        watchers[blogID].close();
        delete watchers[blogID];
      }
      return;
    }

    const { folder, done } = await establishSyncLock(blogID);
    let batchError;

    try {
      for (const path of paths) {
        try {
          await folder.update(path);
        } catch (err) {
          if (!batchError) batchError = err;
        }
      }
    } finally {
      await done(batchError || null);
    }

    if (batchError) throw batchError;
  }

  async function flush() {
    flushTimer = undefined;
    if (running) return;
    running = true;

    try {
      while (pending.size) {
        const paths = [...pending].slice(0, maximumBatchSize);
        paths.forEach((path) => pending.delete(path));
        await processBatch(paths);
      }
    } catch (err) {
      console.error(prefix(), "Unable to process watcher batch", blogID, err);
    } finally {
      running = false;
      if (pending.size) scheduleFlush();
    }
  }

  function scheduleFlush() {
    if (flushTimer || running) return;
    flushTimer = setTimeout(flush, debounceInterval);
  }

  try {
    // chokidar needs a real directory, so this asks for the local path and a
    // blog on the Local client stays on the local-disk backend of
    // storage/folder, whatever BLOT_FOLDER_PRIMARY says (storage/folder/
    // primary.js keeps it there). TODO: the Local client rework in #2258
    // Phase E, watching a directory of its own, lets these blogs run on S3.
    // To stop this watcher, call watcher.close();
    const root = await folder.ensureLocal(blogID, "/");

    if (watchers[blogID]) return;

    const watcher = chokidar.watch(root, {
      cwd: root,
      ignored: shouldIgnoreFile,
      ignoreInitial: true,
    });

    watcher.on("all", (event, path) => {
      if (!path) return;
      // Blot likes leading slashes
      pending.add("/" + path);
      scheduleFlush();
    });

    watchers[blogID] = watcher;
  } catch (e) {
    return console.error(e);
  }
}

module.exports = setup;
