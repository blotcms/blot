const chokidar = require("chokidar");
const Blog = require("models/blog");
const shouldIgnoreFile = require("clients/util/shouldIgnoreFile");
const establishSyncLock = require("sync/establishSyncLock");
const clfdate = require("helper/clfdate");
const { syncPath } = require("./sync");
const source = require("./source");
const prefix = () => clfdate() + " Local folder client:";

const watchers = {};

// Watches the source directory and applies what happens there to the blog's
// folder, through storage/folder, under the sync lock. Resolves once the
// watcher is ready, with { close() }.
async function watch(blogID, dir) {
  const debounceInterval = 50;
  const maximumBatchSize = 100;
  const pending = new Set();
  let flushTimer;
  let running = false;
  let watcher;

  const handle = { close, dir };

  function close() {
    clearTimeout(flushTimer);
    if (watcher) watcher.close();
    if (watchers[blogID] === handle) delete watchers[blogID];
  }

  async function processBatch(paths) {
    const blog = await Blog.get({ id: blogID });

    if (!blog || blog.client !== "local") return close();

    // The handle changed, so the source directory is another one now. Copy
    // the folder into the new directory (the old one stays where it is) and
    // watch that instead.
    if ((await source.directory(blogID)) !== dir) {
      close();
      console.log(prefix(), "Source directory of", blogID, "changed from", dir);
      require("./setup")
        .reconcileSource(blogID)
        .then((newDir) => watch(blogID, newDir))
        .catch((err) =>
          console.error(
            prefix(),
            "Unable to move to the new source directory",
            blogID,
            err
          )
        );
      return;
    }

    const { folder, done } = await establishSyncLock(blogID);
    let batchError;

    try {
      for (const path of paths) {
        try {
          const removed = [];
          try {
            await syncPath(blogID, dir, path, removed);
          } finally {
            // Entries of what was removed along with a directory
            for (const child of removed) await folder.update(child);
          }
          // Always, even when nothing changed: Blot wrote a file to both
          // places itself (write.js) and the entry still has to be built
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

  // One watcher per blog. A watcher on another directory (the blog's handle
  // changed) is replaced; its old directory is left alone, never deleted.
  if (watchers[blogID]) {
    if (watchers[blogID].dir === dir) return watchers[blogID];
    watchers[blogID].close();
  }

  watcher = chokidar.watch(dir, {
    cwd: dir,
    ignored: shouldIgnoreFile,
    ignoreInitial: true,
  });

  watcher.on("all", (event, path) => {
    if (!path) return;
    // Blot likes leading slashes
    pending.add("/" + path);
    scheduleFlush();
  });

  watchers[blogID] = handle;
  await new Promise((resolve) => watcher.once("ready", resolve));
  return handle;
}

module.exports = watch;
