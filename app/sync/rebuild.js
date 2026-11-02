const ensure = require("helper/ensure");
const type = require("helper/type");
const Update = require("./update");
const async = require("async");
const storage = require("storage/folder");
const messenger = require("./messenger");
const assets = require("storage/assets");
const { promisify } = require("util");
const Transformer = require("helper/transformer");
const Blog = require("models/blog");
const build = require("build");
const { isRedisUnavailableError } = require("helper/redisUnavailable");

// Lists every file under the blog's folder as a blog-relative path. Directories
// are read one at a time, and only their names are read: a directory's listing
// says which entries are directories, so there is nothing to stat. Symlinks are
// not listed (storage/folder skips them). The order of the results is not
// guaranteed. An error reading the folder itself is thrown; an error reading a
// subdirectory is skipped, so one unreadable folder does not lose the rest.
async function walk(blogID) {
  const results = [];
  const pending = ["/"];
  let isRoot = true;

  while (pending.length) {
    const current = pending.pop();
    const reading = isRoot;
    let entries;

    isRoot = false;

    try {
      entries = await storage.listNames(blogID, current);
    } catch (err) {
      if (reading) throw err;
      continue;
    }

    for (const { name, isDirectory } of entries) {
      const file = (current === "/" ? "" : current) + "/" + name;

      if (isDirectory) {
        // A "+" folder is a rebuild target in its own right. Once it has
        // been emptied no file path surfaces it, but its stale aggregate
        // entry still needs the EMPTY cleanup, so record the directory too.
        if (name.endsWith("+")) results.push(file);
        pending.push(file);
      } else {
        results.push(file);
      }
    }
  }

  return results;
}

module.exports = function main(blogID, options, callback) {
  if (type(options, "function") && type(callback, "undefined")) {
    callback = options;
    options = {};
  }

  ensure(blogID, "string").and(options, "object").and(callback, "function");

  Blog.get({ id: blogID }, function (err, blog) {
    if (err || !blog) return callback(err || new Error("No blog"));

    const fallbackMessenger =
      options.log && options.status ? null : messenger(blog);
    const log = options.log || fallbackMessenger.log;
    const status = options.status || fallbackMessenger.status;
    // Update's ordinary "Syncing" statuses would split the progress stream.
    // Rebuild publishes the more specific, counted status below instead.
    const updateStatus = function () {};
    const update = new Update(blog, log, updateStatus);

    walk(blog.id).then(async function (paths) {
      try {
        if (options.thumbnails) {
          await wipeCache({
            blogID: blog.id,
            label: "thumbnails",
            directory: "_thumbnails",
          });
        }

        if (options.imageCache) {
          await wipeCache({
            blogID: blog.id,
            label: "image-cache",
            directory: "_image_cache",
          });
        }
      } catch (e) {
        return callback(e);
      }

      // Files inside a + folder all rebuild the same aggregated entry.
      // Process each multi-folder once so a 50-file album is not built
      // 50 separate times during a full rebuild.
      const updatePaths = [];
      const updatePathCounts = new Map();

      paths.forEach(function (path) {
        var multiInfo = build.findMultiFolder(path);

        if (multiInfo) {
          if (!updatePathCounts.has(multiInfo.folderPath)) {
            updatePaths.push(multiInfo.folderPath);
            updatePathCounts.set(multiInfo.folderPath, 0);
          }
          updatePathCounts.set(
            multiInfo.folderPath,
            updatePathCounts.get(multiInfo.folderPath) + 1
          );
          return;
        }

        updatePaths.push(path);
        updatePathCounts.set(path, 1);
      });

      const total = paths.length;
      let current = 0;
      let failed = 0;
      let firstError = null;

      // One at a time on purpose: Entry.set is not safe for two paths of a
      // blog at once (URL claims in models/entry/_setUrl.js and the blog
      // menu in models/entry/_assign.js are read-then-write), see #2258.
      async.eachSeries(
        updatePaths,
        function (path, next) {
          current += updatePathCounts.get(path);
          status(`(${current}/${total}) Rebuilding ${path}`);
          update(path, function (err, result) {
            // Redis is unavailable, so every path after this one would fail
            // the same way. Stop, and tell the caller.
            if (err && isRedisUnavailableError(err)) return next(err);

            // Any other error is about this one file (update reports some as
            // err, such as a symlink in the way, and others in result.error)
            // and must not stop the rebuild of the others. Count them and
            // say so once at the end.
            var fileError = err || (result && result.error);

            if (fileError) {
              failed++;
              if (!firstError) firstError = fileError;
            }

            next();
          });
        },
        (err) => {
          if (err) {
            log("Rebuild stopped, Redis is unavailable", err.message);
            return callback(err);
          }

          if (failed) {
            log(
              `Rebuild finished but ${failed} of ${updatePaths.length} paths failed to build, e.g. ${firstError.message || firstError}`
            );
          }

          // Rebuild can change every entry's parsed fields (e.g. dateStamp,
          // after a dateFormat/timeZone change) without going through
          // sync/index.js's normal "done" flow, which is what usually bumps
          // cacheID. The render caches in the models (e.g. Entries.getCachedPage) key on
          // blogID + cacheID, so without this an unchanged cacheID means a
          // rebuild's fresh entries never invalidate that cache - see
          // https://github.com/blotcms/blot/issues/1844
          Blog.set(blogID, { cacheID: Date.now() }, (err) => {
            callback(err);
          });
        }
      );
    }, callback);
  });
};

async function wipeCache({ blogID, label, directory }) {
  const store = new Transformer(blogID, label);
  const flush = promisify(store.flush);

  await flush();
  // The writers recreate the directory when they next need it
  await assets.remove(blogID, directory);
}
