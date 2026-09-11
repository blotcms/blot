var debug = require("debug")("blot:build");
var fs = require("fs");
var basename = require("path").basename;
var localPath = require("helper/localPath");
var isDraft = require("../sync/update/drafts").isDraft;
var BuildSingle = require("./single");
var BuildMultiple = require("./multiple");
var Prepare = require("./prepare");
var Thumbnail = require("./thumbnail");
var DateStamp = require("./prepare/dateStamp");
var moment = require("moment");
var enabledConverters = require("./converters/enabled");
var pathNormalizer = require("helper/pathNormalizer");

// This file cannot become a blog post because it is not
// a type that Blot can process properly.
function isWrongType(blog, path) {
  var isWrong = true;

  enabledConverters(blog).forEach(function (converter) {
    if (converter.is(path)) isWrong = false;
  });

  return isWrong;
}

function findMultiFolder(path) {
  var normalized = pathNormalizer(path);
  if (!normalized || normalized === "/") return null;

  var segments = normalized.split("/").filter(Boolean);
  var multiIndex = -1;

  // Use the OUTERMOST "+" segment as the folder boundary. Stripping "+" from
  // every ancestor would let distinct trees collide - "/foo+/bar+" and
  // "/foo/bar+" would both resolve to "/foo/bar" and overwrite each other's
  // stored entry. A "+" folder nested inside another "+" folder is not an
  // independent post; its files are already skipped while walking the parent
  // (see collectConvertibleFiles in multiple.js).
  for (var i = 0; i < segments.length; i++) {
    if (segments[i].slice(-1) === "+") {
      multiIndex = i;
      break;
    }
  }

  if (multiIndex === -1) return null;

  var folderSegments = segments.slice(0, multiIndex + 1);
  var entrySegments = folderSegments.map(stripTrailingPlus);

  var folderPath = "/" + folderSegments.join("/");
  var entryPath = "/" + entrySegments.join("/");

  if (!entryPath || entryPath === "//") entryPath = "/";

  return {
    folderPath: folderPath,
    entryPath: entryPath,
    triggerPath: normalized,
  };
}

function stripTrailingPlus(segment) {
  if (!segment) return segment;
  return segment.replace(/\+$/, "");
}

module.exports = function build(blog, path, callback) {
  debug("Build:", process.pid, "processing", path);

  var multiInfo = findMultiFolder(path);

  // findMultiFolder is a path-only check, so a plain file whose name ends in
  // "+" (e.g. /post.md+) matches too. Only treat it as a folder post when the
  // "+" segment is a real directory - otherwise it is just a file, and its
  // plus-stripped path (/post.md) may be a valid sibling we must not disturb.
  if (multiInfo) {
    return fs.stat(
      localPath(blog.id, multiInfo.folderPath),
      function (statErr, stat) {
        buildWith(
          blog,
          path,
          !statErr && stat.isDirectory() ? multiInfo : null,
          callback
        );
      }
    );
  }

  buildWith(blog, path, null, callback);
};

function buildWith(blog, path, multiInfo, callback) {
  var entryPath = multiInfo ? multiInfo.entryPath : path;
  var builder = multiInfo ? BuildMultiple : BuildSingle;
  var buildArgument = multiInfo ? multiInfo : entryPath;

  if (!multiInfo && isWrongType(blog, entryPath)) {
    var err = new Error("Path is wrong type to convert");
    err.code = "WRONGTYPE";
    return callback(err);
  }

  debug("Blog:", blog.id, entryPath, " checking if draft");
  isDraft(blog.id, entryPath, function (err, is_draft) {
    if (err) return callback(err);

    debug("Blog:", blog.id, entryPath, " attempting to build html");
    builder(blog, buildArgument, function (
      err,
      html,
      metadata,
      stat,
      dependencies,
      extras,
    ) {
      if (err) return callback(err);

      metadata = metadata || {};
      stat = stat || {};
      dependencies = dependencies || [];
      extras = extras || {};

      debug("Blog:", blog.id, entryPath, " extracting thumbnail");
      Thumbnail(blog, entryPath, metadata, html, function (err, thumbnail) {
        // Could be lots of reasons (404?)
        if (err || !thumbnail) thumbnail = {};

        var entry;

        // Given the properties above
        // that we've extracted from the
        // local file, compute stuff like
        // the teaser, isDraft etc..

        try {
          entry = {
            html: html,
            name: basename(entryPath),
            path: entryPath,
            id: entryPath,
            thumbnail: thumbnail,
            draft: is_draft,
            metadata: metadata,
            size: typeof stat.size === "number" ? stat.size : 0,
            dependencies: dependencies,
            exif: (extras && extras.exif) || {},
            dateStamp: DateStamp(blog, entryPath, metadata),
            updated: stat && stat.mtime ? moment.utc(stat.mtime).valueOf() : Date.now(),
          };

          if (entry.dateStamp === undefined) {
            entry.dateStampWasRemoved = true;
            delete entry.dateStamp;
          }

          debug(
            "Blog:",
            blog.id,
            entryPath,
            " preparing additional properties for",
            entry.name
          );
          entry = Prepare(entry, {
            titlecase: blog.plugins.titlecase.enabled,
          });
          debug("Blog:", blog.id, path, " additional properties computed.");
        } catch (e) {
          return callback(e);
        }

        callback(null, entry);
      });
    });
  });
}

module.exports.findMultiFolder = findMultiFolder;
