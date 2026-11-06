var joinpath = require("path").join;
var sep = require("path").sep;
var async = require("async");
var callOnce = require("helper/callOnce");
var isOwner = require("./isOwner");
var getAllViews = require("./getAllViews");
var withCallback = require("helper/withCallback");
var folder = require("storage/folder"); // reads only
var blogFolder = require("clients/folder");
var callbackify = require("util").callbackify;
var generatePackage = require("./package").generate;
var determineTemplateFolder = require("./determineTemplateFolder");
var withFolderLock = require("./withFolderLock");
var PACKAGE = "package.json";
const shouldIgnoreFile = require("clients/util/shouldIgnoreFile");

function writeToFolderUnlocked(blogID, templateID, callback) {
  isOwner(blogID, templateID, function (err, owner) {
    if (err) return callback(err);

    if (!owner) return callback(badPermission(blogID, templateID));

    withCallback(getAllViews)(templateID, function (err, result) {
      if (err) return callback(err);

      var views = result.views;
      var metadata = result.metadata;

      if (!views || !metadata) return callback(noTemplate(blogID, templateID));

      determineTemplateFolder(blogID, function (folderErr, folderName) {
        if (folderErr) {
          return callback(folderErr);
        }

        var dir = joinpath(folderName, metadata.slug);
        var shouldCompareWrites = true;

        listLocalFiles(blogID, dir, function (err, existingFiles) {
          if (err) {
            return callback(err);
          }

          writeTemplateContents(
            blogID,
            dir,
            metadata,
            views,
            {
              compare: shouldCompareWrites,
              existingFiles: existingFiles,
            },
            callback
          );
        });
      });
    });
  });
}

function writePackage(blogID, dir, metadata, views, compare, callback) {
  var Package = generatePackage(blogID, metadata, views);
  writeFile(blogID, joinpath(dir, PACKAGE), Package, compare, callback);
}

function write(blogID, dir, view, compare, callback) {
  callback = callOnce(callback);

  var path = joinpath(dir, view.name);
  var content = view.content;

  writeFile(blogID, path, content, compare, callback);
}

function writeFile(blogID, path, content, compare, callback) {
  if (shouldIgnoreFile(path)) {
    // Silently skip ignored files to avoid breaking legacy templates
    // that may have ignored files in their stored views
    return callback();
  }

  if (typeof compare === "function") {
    callback = compare;
    compare = true;
  }

  // The client's write also writes Blot's copy of the folder
  function writeThroughClient() {
    callbackify(blogFolder.write)(blogID, path, content, callback);
  }

  if (!compare) return writeThroughClient();

  callbackify(folder.read)(blogID, path, function (err, existing) {
    if (!err && existing.toString("utf-8") === content) return callback();
    writeThroughClient();
  });
}

function writeTemplateContents(
  blogID,
  dir,
  metadata,
  views,
  options,
  callback
) {
  options = options || {};

  var compare = options.compare !== false;
  var existingFiles = Array.isArray(options.existingFiles)
    ? options.existingFiles.map(normalizePath)
    : null;
  var written = existingFiles ? new Set([normalizePath(PACKAGE)]) : null;

  writePackage(blogID, dir, metadata, views, compare, function (err) {
    if (err) {
      return callback(err);
    }

    async.eachOfSeries(
      views,
      function (view, name, next) {
        if (!view || !view.name || !view.content) return next();

        write(blogID, dir, view, compare, function (err) {
          if (!err && written) written.add(normalizePath(view.name));
          next(err);
        });
      },
      function (err) {
        if (err) return callback(err);

        if (written) {
          removeOrphanedFiles(blogID, dir, existingFiles, written, callback);
        } else {
          callback();
        }
      }
    );
  });
}

function listLocalFiles(blogID, dir, callback) {
  callbackify(folder.listNames)(blogID, dir, function (err, entries) {
    if (err) {
      if (err.code === "ENOENT" || err.code === "ENOTDIR")
        return callback(null, []);
      return callback(err);
    }

    // Only the files directly inside the template's folder count. A view's
    // name can't hold a backslash, so a file with one is never an orphan.
    callback(
      null,
      entries
        .filter(function (entry) {
          return (
            !entry.isDirectory &&
            !/\\/.test(entry.name) &&
            !shouldIgnoreFile(entry.name)
          );
        })
        .map(function (entry) {
          return normalizePath(entry.name);
        })
    );
  });
}

function removeOrphanedFiles(blogID, dir, existingFiles, written, callback) {
  var toRemove = existingFiles.filter(function (file) {
    return !written.has(normalizePath(file));
  });

  async.eachSeries(
    toRemove,
    function (file, next) {
      var relativePath = joinpath(dir, file);

      // The client's remove also removes Blot's copy
      callbackify(blogFolder.remove)(blogID, relativePath, function (err) {
        if (err && err.code !== "ENOENT") return next(err);
        next();
      });
    },
    callback
  );
}

function normalizePath(path) {
  return typeof path === "string" ? path.split(sep).join("/") : path;
}

function badPermission(blogID, templateID) {
  return new Error("No permission for " + blogID + " to write " + templateID);
}

function noTemplate(blogID, templateID) {
  return new Error("No template for " + blogID + " and " + templateID);
}

module.exports = withFolderLock(writeToFolderUnlocked);
