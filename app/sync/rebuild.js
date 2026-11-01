const fs = require("fs-extra");
const ensure = require("helper/ensure");
const type = require("helper/type");
const Update = require("./update");
const async = require("async");
const { join, resolve, basename } = require("path");
const localPath = require("helper/localPath");
const messenger = require("./messenger");
const assets = require("storage/assets");
const { promisify } = require("util");
const Transformer = require("helper/transformer");
const Blog = require("models/blog");
const build = require("build");
const { isRedisUnavailableError } = require("helper/redisUnavailable");

// The most stats in flight at once while walking a folder, so a blog with a
// huge folder cannot open an unbounded number of them.
const WALK_CONCURRENCY = 32;

// How many paths a rebuild builds at once. Building is the slow part and
// entries are still saved one at a time (models/entry/set.js).
const BUILD_CONCURRENCY = 4;

// Lists every file under dir. Directories are read one at a time and each is
// stat'd with bounded concurrency. The order of the results is not
// guaranteed. An error reading dir itself is returned; an error reading a
// subdirectory is skipped, so one unreadable folder does not lose the rest.
function walk(dir, done) {
  const results = [];
  const pending = [dir];

  function next(isRoot) {
    const current = pending.pop();

    if (current === undefined) return done(null, results);

    fs.readdir(current, function (err, list) {
      if (err) {
        if (isRoot) return done(err);
        return next(false);
      }

      async.eachLimit(
        list,
        WALK_CONCURRENCY,
        function (name, cb) {
          const file = resolve(current, name);

          fs.stat(file, function (err, stat) {
            if (stat && stat.isDirectory()) {
              // A "+" folder is a rebuild target in its own right. Once it has
              // been emptied no file path surfaces it, but its stale aggregate
              // entry still needs the EMPTY cleanup, so record the directory too.
              if (basename(file).endsWith("+")) results.push(file);
              pending.push(file);
            } else {
              results.push(file);
            }

            cb();
          });
        },
        function () {
          next(false);
        }
      );
    });
  }

  next(true);
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

    let blogDirectory = localPath(blog.id, "/");

    if (blogDirectory.endsWith("/")) blogDirectory = blogDirectory.slice(0, -1);

    walk(blogDirectory, async function (err, paths) {
      if (err) return callback(err);

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

      paths.forEach(function (absPath) {
        var path = absPath.slice(blogDirectory.length);
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

      let stopped = null;

      async.eachLimit(
        updatePaths,
        BUILD_CONCURRENCY,
        function (path, next) {
          // Finish what is in flight rather than failing straight away, so
          // nothing is still building once the caller hears about it.
          if (stopped) return next();

          current += updatePathCounts.get(path);
          status(`(${current}/${total}) Rebuilding ${path}`);
          update(path, function (err, result) {
            // Redis is unavailable, so every path after this one would fail
            // the same way. Stop, and tell the caller.
            if (err && isRedisUnavailableError(err)) {
              stopped = stopped || err;
              return next();
            }

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
        () => {
          if (stopped) {
            log("Rebuild stopped, Redis is unavailable", stopped.message);
            return callback(stopped);
          }

          if (failed) {
            log(
              `Rebuild finished but ${failed} of ${updatePaths.length} paths failed to build, e.g. ${firstError.message || firstError}`
            );
          }

          // Rebuild can change every entry's parsed fields (e.g. dateStamp,
          // after a dateFormat/timeZone change) without going through
          // sync/index.js's normal "done" flow, which is what usually bumps
          // cacheID. render/retrieve/posts.js keys its process-wide cache on
          // blogID + cacheID, so without this an unchanged cacheID means a
          // rebuild's fresh entries never invalidate that cache - see
          // https://github.com/blotcms/blot/issues/1844
          Blog.set(blogID, { cacheID: Date.now() }, (err) => {
            callback(err);
          });
        }
      );
    });
  });
};

async function wipeCache({ blogID, label, directory }) {
  const store = new Transformer(blogID, label);
  const flush = promisify(store.flush);

  await flush();
  // The writers recreate the directory when they next need it
  await assets.remove(blogID, directory);
}
