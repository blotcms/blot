const Blog = require("models/blog");
const config = require("config");
const chokidar = require("chokidar");
const shouldIgnoreFile = require("clients/util/shouldIgnoreFile");
const localPath = require("helper/localPath");
const Fix = require("sync/fix");
const syncReport = require("clients/util/syncReport");
const establishSyncLock = require("sync/establishSyncLock");
const clfdate = require("helper/clfdate");
const prefix = () => clfdate() + " Local folder client:";

let watchers = {};

function setup(blogID, callback) {
  Blog.get({ id: blogID }, function (err, blog) {
    if (err || !blog) return callback();
    Fix(blog, function (err, report) {
      if (err) return callback();
      const repaired = syncReport.summarize(report);
      if (repaired) console.log(prefix(), "Fix repaired", blogID, repaired);
      if (config.environment === "development") {
        watch(blogID);
      }
      console.log(prefix(), "Setup complete", blogID);
      callback();
    });
  });
}

function watch(blogID) {
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
    if (watchers[blogID]) return;

    // To stop this watcher, call watcher.close();
    const watcher = chokidar.watch(localPath(blogID, "/"), {
      cwd: localPath(blogID, "/"),
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
