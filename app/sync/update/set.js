var rebuildDependents = require("./rebuildDependents");
var Ignore = require("./ignore");
var Entry = require("models/entry");
var Preview = require("./preview");
var isPreview = require("./drafts").isPreview;
var isDraft = require("./drafts").isDraft;
var async = require("async");
var WRONG_TYPE = "WRONG_TYPE";
var TOO_LARGE = "TOO_LARGE";
var PUBLIC_FILE = "PUBLIC_FILE";
var isHidden = require("build/prepare/isHidden");
var build = require("build");
var pathNormalizer = require("helper/pathNormalizer");
var makeSlug = require("helper/makeSlug");
var path = require("path");
var IgnoredFiles = require("models/ignoredFiles");
var isUnsafeFolderPostPreview = require("./isUnsafeFolderPostPreview");
var folderPostSourceFolder = require("./folderPostSourceFolder");

var basename = (path.posix || path).basename;
var noop = () => {};

function isPublic(path) {
  const normalizedPath = pathNormalizer(path).toLowerCase();
  return (
    // blot specific rule not to turn files inside
    // a folder called public into blog posts
    normalizedPath.startsWith("/public/") ||
    // blot specific rule to ignore files and folders
    // whose name begins with an underscore
    normalizedPath.includes("/_") ||
    // convention to ingore dotfiles or folders
    normalizedPath.includes("/.") || 
    // textbundle asset files
    normalizedPath.includes(".textbundle/assets/")
  );
}

function isTemplate(path) {
  return pathNormalizer(path).toLowerCase().startsWith("/templates/");
}

function dropEntryAndPreview(blogID, targetPath, callback) {
  targetPath = pathNormalizer(targetPath);

  Entry.get(blogID, targetPath, function (entry) {
    if (!entry) return callback();

    var skipPreview = isUnsafeFolderPostPreview(targetPath, entry.html);

    Entry.drop(blogID, targetPath, function (err) {
      if (err) return callback(err);

      if (entry.draft && !isHidden(targetPath) && !skipPreview) {
        Preview.remove(blogID, targetPath, callback);
      } else {
        callback();
      }
    });
  });
}

function buildAndSet(blog, path, multiInfo, callback) {
  build(blog, path, function (err, entry) {
    // When a "+" folder can no longer build an aggregate (its files are gone,
    // it was replaced by a file, ...), the previously published entry at the
    // plus-stripped path is stale and should be dropped - but only when that
    // entry really is this folder's aggregate. A plain "/post.md+" file must
    // not unpublish an unrelated "/post.md" sibling.
    function dropStaleAggregate(finalErr) {
      if (!multiInfo) return callback(finalErr);
      Entry.get(blog.id, multiInfo.entryPath, function (existing) {
        var sourceFolder = folderPostSourceFolder(existing);
        if (
          sourceFolder &&
          pathNormalizer(sourceFolder) === pathNormalizer(multiInfo.folderPath)
        ) {
          return dropEntryAndPreview(blog.id, multiInfo.entryPath, callback);
        }
        return callback(finalErr);
      });
    }

    if (err && err.code === "WRONGTYPE")
      return Ignore(blog.id, path, WRONG_TYPE, function (ignoreErr) {
        if (ignoreErr) return callback(ignoreErr);
        dropStaleAggregate();
      });

    if (err && err.code === TOO_LARGE) {
      // If this file was previously published as a draft, Preview.write
      // already dropped a companion .preview.html into the user's folder.
      // Mirror the cleanup in app/sync/update/drop.js so we don't leave an
      // orphaned preview behind now that the source can't become a post.
      return isDraft(blog.id, path, function (draftErr, is_draft) {
        if (!draftErr && is_draft) Preview.remove(blog.id, path);
        Ignore(blog.id, path, TOO_LARGE, function (ignoreErr) {
          // An oversized source inside a "+" folder aborts the whole
          // aggregate build, so drop the now-stale synthesized entry too.
          if (ignoreErr) return callback(ignoreErr);
          dropStaleAggregate();
        });
      });
    }

    // A "+" folder whose plus-stripped path is a real sibling file (e.g.
    // "/article.md+" beside "/article.md") is not aggregated - the file keeps
    // its own entry.
    if (err && err.code === "PLUS_PATH_COLLISION") return callback();

    // EMPTY / TOO_MANY_FILES only fire for a genuine directory, so an empty
    // folder is just "nothing to publish" - not an error to propagate.
    if (err && ["EMPTY", "TOO_MANY_FILES"].indexOf(err.code) !== -1)
      return dropStaleAggregate();

    // ENOTDIR / ENOENT can also come from a plain "+"-suffixed file whose
    // stripped path is a valid sibling; keep the error unless we cleaned up a
    // real aggregate.
    if (err && ["ENOTDIR", "ENOENT"].indexOf(err.code) !== -1)
      return dropStaleAggregate(err);

    if (err) return callback(err);

    var sourcePaths = [];

    if (entry.metadata && Array.isArray(entry.metadata._sourcePaths)) {
      sourcePaths = entry.metadata._sourcePaths
        .map(pathNormalizer)
        .filter(Boolean);
    }

    var dropTargets = sourcePaths
      .filter(function (sourcePath) {
        return sourcePath !== entry.path;
      })
      .filter(function (value, index, array) {
        return array.indexOf(value) === index;
      });

    async.series(
      [
        function (next) {
          async.eachSeries(
            dropTargets,
            function (target, done) {
              dropEntryAndPreview(blog.id, target, done);
            },
            next
          );
        },
        function (next) {
          if (entry.metadata && entry.metadata._sourcePaths)
            delete entry.metadata._sourcePaths;

          Entry.set(blog.id, entry.path, entry, function (err) {
            if (err) return next(err);

            // A successful rebuild means any previous "ignored" record for
            // this path (wrong type, too large, …) is stale. Clear it
            // best-effort — it must not hold up or fail the sync. For a
            // folder post the same applies to each source file that is now
            // part of the aggregate again (e.g. one shrunk back under the
            // size limit), otherwise the dashboard keeps hiding its badge.
            IgnoredFiles.drop(blog.id, entry.path, noop);
            sourcePaths.forEach(function (sourcePath) {
              IgnoredFiles.drop(blog.id, sourcePath, noop);
            });

            const syntheticKeys = new Set();

            const slugToken = makeSlug(
              entry.slug || entry.metadata.title || entry.title || ""
            );
            if (slugToken) {
              syntheticKeys.add(`/__wikilink_slug__/${slugToken}`);
            }

            const filenameToken = entry.path ? basename(entry.path) : "";
            if (filenameToken) {
              syntheticKeys.add(`/__wikilink_filename__/${filenameToken}`);
            }

            syntheticKeys.forEach((syntheticKey) =>
              rebuildDependents(blog.id, syntheticKey, noop)
            );

            // A draft folder post outside /drafts/ would write "/album.html"
            // and could clobber a real sibling source file, so skip the
            // filesystem preview there (still viewable via the draft URL).
            if (
              entry.draft &&
              !isHidden(entry.path) &&
              !isUnsafeFolderPostPreview(entry.path, entry.html)
            ) {
              Preview.write(blog.id, entry.path, next);
            } else {
              next();
            }
          });
        },
      ],
      callback
    );
  });
}

module.exports = function (blog, path, callback) {
  // if typoeof callback is not function, throw error
  if (typeof callback !== "function") {
    throw new Error("sync.set: callback must be a function");
  }

  // if typeof blog is not object, return error
  if (typeof blog !== "object") {
    return callback(new Error("sync.set: blog must be an object"));
  }

  // if typeof path is not string, return error
  if (typeof path !== "string") {
    return callback(new Error("sync.set: path must be a string"));
  }

  path = pathNormalizer(path);

  var queue = {};
  var multiInfo = build.findMultiFolder(path);

  isPreview(blog.id, path, function (err, is_preview) {
    if (err) return callback(err);

    // The file is public. Its name begins
    // with an underscore, or it's inside a folder
    // whose name begins with an underscore. It should
    // therefore not be a blog post.
    if (isPublic(path)) {
      queue.ignore = Ignore.bind(this, blog.id, path, PUBLIC_FILE);
    }

    // This file should become a blog post or page!
    if (!isPublic(path) && !isTemplate(path) && !is_preview) {
      queue.buildAndSet = buildAndSet.bind(this, blog, path, multiInfo);
    }

    async.parallel(queue, function (err) {
      if (err) return callback(err);

      var targets = [path];

      if (multiInfo && multiInfo.entryPath)
        targets.push(pathNormalizer(multiInfo.entryPath));

      targets = targets
        .map(pathNormalizer)
        .filter(function (value, index, array) {
          return array.indexOf(value) === index;
        });

      async.eachSeries(
        targets,
        function (target, next) {
          rebuildDependents(blog.id, target, next);
        },
        callback
      );
    });
  });
};
