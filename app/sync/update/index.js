var assertNoSymlinks = require("helper/assertNoSymlinks");
var fs = require("fs-extra");
var localPath = require("helper/localPath");
var clfdate = require("helper/clfdate");
var hashFile = require("helper/hashFile");
var drop = require("./drop");
var set = require("./set");
var flushCache = require("models/blog/flushCache");
var pathNormalizer = require("helper/pathNormalizer");
var Blog = require("models/blog");
var build = require("build");
var Entry = require("models/entry");
var folderPostSourceFolder = require("./folderPostSourceFolder");

module.exports = function (blog, log, status) {
  return function update(path, callback) {
    // if typoeof callback is not function, throw error
    if (typeof callback !== "function") {
      throw new Error("sync.update: callback must be a function");
    }

    // if typeof path is not string, return error
    if (typeof path !== "string") {
      return callback(new Error("sync.update: path must be a string"));
    }

    path = pathNormalizer(path);

    status("Syncing " + path);

    assertNoSymlinks(localPath(blog.id, "/"), localPath(blog.id, path)).then(function () {
      hashFile(localPath(blog.id, path), function (err, hashBefore) {
        function done(err) {
          // we never let this error escape out
          if (err) {
            console.error(clfdate(), blog.id, path, err);
          }
          hashFile(localPath(blog.id, path), function (err, hashAfter) {
            if (hashBefore !== hashAfter) {
              status("Re-syncing " + path);
              return update(path, callback);
            }

            // the cache is flushed at the end of a sync too
            // but if we don't do it after updating each files
            // long syncs can produce weird cache behaviour
            flushCache(blog.id, function () {
              callback(null, { error: err || null });
            });
          });
        }

        fs.stat(localPath(blog.id, path), function (err, stat) {
          if (err && err.code === "ENOENT") {
            var multiInfo = build.findMultiFolder(path);

            resolveEnoentTargets(blog, path, multiInfo, function (targets) {
              var dropTargets = targets.dropTargets;
              var rebuildTarget = targets.rebuildTarget;
              var dropError = null;

              function nextDrop(index) {
                if (index >= dropTargets.length) {
                  if (!rebuildTarget) return done(dropError);

                  return fs.pathExists(
                    localPath(blog.id, rebuildTarget),
                    function (existsErr, exists) {
                      if (existsErr) {
                        if (!dropError) dropError = existsErr;
                        return done(dropError);
                      }

                      if (!exists) return done(dropError);

                      log(rebuildTarget, "Rebuilding multi-folder in database");

                      set(blog, rebuildTarget, function (err) {
                        if (err) {
                          log(
                            rebuildTarget,
                            "Error rebuilding multi-folder in database",
                            err
                          );
                          if (!dropError) dropError = err;
                        } else {
                          log(
                            rebuildTarget,
                            "Rebuilding multi-folder in database succeeded"
                          );
                        }

                        done(dropError);
                      });
                    }
                  );
                }

                var target = dropTargets[index];
                log(target, "Dropping from database");
                drop(blog.id, target, function (err) {
                  if (err) {
                    log(target, "Error dropping from database", err);
                    if (!dropError) dropError = err;
                  } else {
                    log(target, "Dropping from database succeeded");
                  }

                  nextDrop(index + 1);
                });
              }

              nextDrop(0);
            });
          } else if (stat && stat.isDirectory()) {
            maybeEnableInjectTitle(blog, path, function () {
              var multiInfo = build.findMultiFolder(path);

              if (multiInfo) {
                var targetPath = multiInfo.folderPath;

                log(path, "Saving multi-folder in database");

                set(blog, targetPath, function (err) {
                  if (err) {
                    log(targetPath, "Error saving multi-folder in database", err);
                  } else {
                    log(targetPath, "Saving multi-folder in database succeeded");
                  }
                  done(err);
                });
              } else {
                // there is nothing else to do for directories
                done();
              }
            });
          } else {
            log(path, "Saving file in database");
            set(blog, path, function (err) {
              if (err) {
                log(path, "Error saving file in database", err);
              } else {
                log(path, "Saving file in database succeeded");
              }
              done(err);
            });
          }
        });
      });
    }, callback);
  };
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
function resolveEnoentTargets(blog, path, multiInfo, callback) {
  if (multiInfo && multiInfo.folderPath === path && multiInfo.entryPath) {
    return Entry.get(blog.id, multiInfo.entryPath, function (existing) {
      var sourceFolder = folderPostSourceFolder(existing);
      var isOwnAggregate =
        sourceFolder &&
        pathNormalizer(sourceFolder) === pathNormalizer(multiInfo.folderPath);

      callback({
        dropTargets: isOwnAggregate ? [path, multiInfo.entryPath] : [path],
        rebuildTarget: null,
      });
    });
  }

  if (multiInfo && multiInfo.folderPath !== path && multiInfo.folderPath) {
    return callback({
      dropTargets: [path],
      rebuildTarget: multiInfo.folderPath,
    });
  }

  var siblingFolder = path + "+";

  fs.pathExists(localPath(blog.id, siblingFolder), function (err, exists) {
    callback({
      dropTargets: [path],
      rebuildTarget: !err && exists ? siblingFolder : null,
    });
  });
}

// Obsidian references the file system path as the note title, so the exported
// Markdown often lacks an `h1`. To keep published posts readable, we auto-enable
// the injectTitle plugin when a `.obsidian` folder is detected—unless the author
// has explicitly turned it off.
function maybeEnableInjectTitle(blog, path, callback) {
  try {
    const normalizedPath = pathNormalizer(path).toLowerCase();

    const segments = normalizedPath.split("/").filter(Boolean);

    const hasObsidianFolder = segments.includes(".obsidian");

    if (!hasObsidianFolder) return callback();

    const currentPlugins = blog.plugins || {};
    const injectTitleConfig = currentPlugins.injectTitle || {};
    const currentOptions = injectTitleConfig.options || {};

    if (currentOptions.manuallyDisabled) return callback();

    if (injectTitleConfig.enabled) return callback();

    const nextPlugins = Object.assign({}, currentPlugins);
    const nextOptions = Object.assign({}, currentOptions, {
      manuallyDisabled: false,
    });

    nextPlugins.injectTitle = Object.assign({}, injectTitleConfig, {
      enabled: true,
      options: nextOptions,
    });

    Blog.set(
      blog.id,
      {
        plugins: nextPlugins,
      },
      function (err) {
        if (!err) {
          blog.plugins = nextPlugins;
        }
        if (err) console.error(clfdate(), blog.id, path, err);
        callback();
      }
    );
  } catch (error) {
    console.error(clfdate(), blog.id, path, error);
    callback();
  }
}
