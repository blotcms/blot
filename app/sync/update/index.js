var withCallback = require("helper/withCallback");
var storage = require("storage/folder");
var clfdate = require("helper/clfdate");
var drop = require("./drop");
var set = require("./set");
var flushCache = require("models/blog/flushCache");
var pathNormalizer = require("helper/pathNormalizer");
var Blog = require("models/blog");
var build = require("build");
var Entry = require("models/entry");
var folderPostSourceFolder = require("./folderPostSourceFolder");
var isRedisUnavailableError =
  require("helper/redisUnavailable").isRedisUnavailableError;

// Keep the first error, except that a Redis outage always wins: it is the
// only kind that update() passes on, so a per-file error seen earlier in the
// same update must not hide it.
function firstError(current, next) {
  if (!next) return current;
  if (!current) return next;
  if (isRedisUnavailableError(current)) return current;
  return isRedisUnavailableError(next) ? next : current;
}

// A cheap stand-in for hashing the file: if the size or mtime differ between
// the start and end of an update, the file changed while it was processed.
// Only regular files get one. A directory's mtime moves when a build writes
// its .preview.html files into it, which would re-sync forever, and a missing
// path has nothing to compare, so both are null. The fingerprint only lives
// for the length of one update, in this process: nothing stores it.
//
// modified is the mtime in milliseconds as a float, which keeps the
// sub-millisecond part of the time a filesystem reports (about a quarter of a
// microsecond at today's dates), where this once compared it in nanoseconds.
function fingerprint(stat) {
  if (!stat || stat.isDirectory) return null;
  return stat.size + ":" + stat.modified;
}

module.exports = function (blog, log, status) {
  // The re-syncs below call this one directly, not the exported function
  // with its callback bridge.
  async function update(path) {
    // if typeof path is not string, return error
    if (typeof path !== "string") {
      throw new Error("sync.update: path must be a string");
    }

    path = pathNormalizer(path);

    status("Syncing " + path);

    var stat = null;
    var missing = false;

    // A symlink at the path or in its way rejects with ELOOP, which (like any
    // error other than a missing path) is the caller's to handle.
    try {
      stat = await storage.stat(blog.id, path);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      missing = true;
    }

    var before = fingerprint(stat);

    // result: set's, e.g. { changed: false } when nothing was written
    async function done(err, result) {
      if (err) {
        console.error(clfdate(), blog.id, path, err);
      }

      // Redis cannot take the write (a host cutover, a restart, an
      // outage), so the database does not reflect the file on disk. The
      // client must know, otherwise it marks the change as applied and
      // nothing ever builds the entry. Skip the re-check and cache flush:
      // both would only wait on the same Redis.
      if (err && isRedisUnavailableError(err)) throw err;

      // Any other error is usually about this one file (a source that
      // will not build, say) and must not stop the rest of the sync,
      // so it is logged above and never escapes.
      var updateError = err;
      var afterStat;
      var statErr = null;

      try {
        afterStat = await storage.stat(blog.id, path);
      } catch (err) {
        statErr = err;
      }

      var after = statErr ? null : fingerprint(afterStat);

      if (before !== after) {
        status("Re-syncing " + path);

        // This pass may already have stored the file's new entry, which
        // the next one then finds unchanged: the change still needs its
        // purge, and the sync its cacheID bump
        var changedHere = !(result && result.changed === false);

        var retried = await update(path);

        if (changedHere && retried && retried.changed === false) {
          // An error flushing is ignored
          try {
            await flushCache(blog.id);
          } catch (err) {}

          return { error: retried.error || null };
        }

        return retried;
      }

      // The file built the entry already stored: nothing to purge.
      // Calls back { changed: false } so the sync can skip its cacheID
      // bump too, when no other file changed (see sync/index.js).
      if (!updateError && result && result.changed === false) {
        return { error: null, changed: false };
      }

      // the cache is flushed at the end of a sync too
      // but if we don't do it after updating each files
      // long syncs can produce weird cache behaviour
      // An error flushing is ignored
      try {
        await flushCache(blog.id);
      } catch (err) {}

      return { error: updateError || null };
    }

    if (missing) {
      var multiInfo = build.findMultiFolder(path);

      var targets = await resolveEnoentTargets(blog, path, multiInfo);

      if (targets.error) return done(targets.error);

      var dropTargets = targets.dropTargets;
      var rebuildTarget = targets.rebuildTarget;
      var dropError = null;

      for (const target of dropTargets) {
        log(target, "Dropping from database");

        try {
          await drop(blog.id, target);
          log(target, "Dropping from database succeeded");
        } catch (err) {
          log(target, "Error dropping from database", err);
          dropError = firstError(dropError, err);
        }
      }

      if (!rebuildTarget) return done(dropError);

      var exists;

      try {
        exists = await storage.exists(blog.id, rebuildTarget);
      } catch (existsErr) {
        dropError = firstError(dropError, existsErr);
        return done(dropError);
      }

      if (!exists) {
        // The "+" folder this file was inside is gone too (every
        // file was removed and the client reported only the
        // files, as a push to a repository does), so its
        // aggregate is stale. Sync the folder path: that drops
        // the aggregate only if it is really this folder's,
        // never a colliding sibling's.
        if (multiInfo && rebuildTarget === multiInfo.folderPath) {
          var folderErr;
          var folderResult;

          try {
            folderResult = await update(rebuildTarget);
          } catch (err) {
            folderErr = err;
          }

          // A Redis outage comes back as folderErr
          return done(
            firstError(
              dropError,
              folderErr || (folderResult && folderResult.error)
            )
          );
        }

        return done(dropError);
      }

      log(rebuildTarget, "Rebuilding multi-folder in database");

      try {
        await set(blog, rebuildTarget);
        log(rebuildTarget, "Rebuilding multi-folder in database succeeded");
      } catch (err) {
        log(rebuildTarget, "Error rebuilding multi-folder in database", err);
        dropError = firstError(dropError, err);
      }

      return done(dropError);
    }

    if (stat.isDirectory) {
      await maybeEnableInjectTitle(blog, path);

      var folderInfo = build.findMultiFolder(path);

      // there is nothing else to do for directories
      if (!folderInfo) return done();

      var targetPath = folderInfo.folderPath;

      log(path, "Saving multi-folder in database");

      try {
        await set(blog, targetPath);
        log(targetPath, "Saving multi-folder in database succeeded");
      } catch (err) {
        log(targetPath, "Error saving multi-folder in database", err);
        return done(err);
      }

      return done();
    }

    log(path, "Saving file in database");

    var setResult;
    var setError;

    try {
      setResult = await set(blog, path);
      log(path, "Saving file in database succeeded");
    } catch (err) {
      setError = err;
      log(path, "Error saving file in database", err);
    }

    return done(setError, setResult);
  }

  return withCallback(update);
};

// A path that has vanished from disk (ENOENT) needs to work out what to drop
// and what to rebuild:
//  - the deleted path is a "+" folder itself: its aggregate is stale, but
//    only drop the plus-stripped entry if it is genuinely this folder's
//    aggregate - a colliding sibling file (e.g. "/article.md" beside
//    "/article.md+") may own that entry instead, and must not be unpublished.
//  - the deleted path is a file inside a "+" folder: rebuild the aggregate
//    without it.
//  - the deleted path is a plain file that shares its name with a "+" folder
//    (e.g. deleting "/article.md" frees up "/article.md+" to finally
//    aggregate): rebuild that folder now that the collision is gone.
async function resolveEnoentTargets(blog, path, multiInfo) {
  if (multiInfo && multiInfo.folderPath === path && multiInfo.entryPath) {
    var existing;
    var getErr;

    try {
      existing = await Entry.get(blog.id, multiInfo.entryPath);
    } catch (err) {
      getErr = err;
    }

    // Without the entry we cannot tell whose aggregate it is, and guessing
    // could unpublish the wrong post
    if (!existing && getErr && isRedisUnavailableError(getErr))
      return { error: getErr };

    var sourceFolder = folderPostSourceFolder(existing);
    var isOwnAggregate =
      sourceFolder &&
      pathNormalizer(sourceFolder) === pathNormalizer(multiInfo.folderPath);

    return {
      dropTargets: isOwnAggregate ? [path, multiInfo.entryPath] : [path],
      rebuildTarget: null,
    };
  }

  if (multiInfo && multiInfo.folderPath !== path && multiInfo.folderPath) {
    return {
      dropTargets: [path],
      rebuildTarget: multiInfo.folderPath,
    };
  }

  var siblingFolder = path + "+";
  var exists = false;

  try {
    exists = await storage.exists(blog.id, siblingFolder);
  } catch (err) {
    // An error checking is the same as no folder
  }

  return {
    dropTargets: [path],
    rebuildTarget: exists ? siblingFolder : null,
  };
}

// Obsidian references the file system path as the note title, so the exported
// Markdown often lacks an `h1`. To keep published posts readable, we auto-enable
// the injectTitle plugin when a `.obsidian` folder is detected—unless the author
// has explicitly turned it off. Never rejects: a failure is logged and the
// sync carries on.
async function maybeEnableInjectTitle(blog, path) {
  try {
    const normalizedPath = pathNormalizer(path).toLowerCase();

    const segments = normalizedPath.split("/").filter(Boolean);

    const hasObsidianFolder = segments.includes(".obsidian");

    if (!hasObsidianFolder) return;

    const currentPlugins = blog.plugins || {};
    const injectTitleConfig = currentPlugins.injectTitle || {};
    const currentOptions = injectTitleConfig.options || {};

    if (currentOptions.manuallyDisabled) return;

    if (injectTitleConfig.enabled) return;

    const nextPlugins = Object.assign({}, currentPlugins);
    const nextOptions = Object.assign({}, currentOptions, {
      manuallyDisabled: false,
    });

    nextPlugins.injectTitle = Object.assign({}, injectTitleConfig, {
      enabled: true,
      options: nextOptions,
    });

    try {
      await Blog.set(blog.id, {
        plugins: nextPlugins,
      });

      blog.plugins = nextPlugins;
    } catch (err) {
      console.error(clfdate(), blog.id, path, err);
    }
  } catch (error) {
    console.error(clfdate(), blog.id, path, error);
  }
}
