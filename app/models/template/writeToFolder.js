var joinpath = require("path").join;
var sep = require("path").sep;
var async = require("async");
var callOnce = require("helper/callOnce");
var isOwner = require("./isOwner");
var getAllViews = require("./getAllViews");
var localPath = require("helper/localPath");
var fs = require("fs-extra");
var generatePackage = require("./package").generate;
var determineTemplateFolder = require("./determineTemplateFolder");
var withFolderLock = require("./withFolderLock");
var PACKAGE = "package.json";
const shouldIgnoreFile = require("clients/util/shouldIgnoreFile");

function writeToFolderUnlocked (blogID, templateID, callback) {
  isOwner(blogID, templateID, function (err, owner) {
    if (err) return callback(err);

    if (!owner) return callback(badPermission(blogID, templateID));

    getAllViews(templateID, function (err, views, metadata) {
      if (err) return callback(err);

      if (!views || !metadata) return callback(noTemplate(blogID, templateID));

      makeClient(blogID, function (err, client, blogTemplate) {
        if (err) {
          return callback(err);
        }

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
              client,
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
  });
}

function writePackage (blogID, client, dir, metadata, views, compare, callback) {
  var Package = generatePackage(blogID, metadata, views);
  writeFile(blogID, client, joinpath(dir, PACKAGE), Package, compare, callback);
}

function makeClient (blogID, callback) {
  require("models/blog").get({ id: blogID }, function (err, blog) {
    var client = require("clients")[blog.client];

    // we create a fake client to write the template files directly
    // to the blog's folder if the user has not configured a client
    if (!blog.client || !client) {
      return callback(null, {
        remove: function (blogID, path, callback) {
          fs.remove(localPath(blogID, path), callback);
        },
        write: function (blogID, path, content, callback) {
          fs.outputFile(localPath(blogID, path), content, callback);
        }
      });
    }

    return callback(null, client, blog.template);
  });
}

function write (blogID, client, dir, view, compare, callback) {
  callback = callOnce(callback);

  var path = joinpath(dir, view.name);
  var content = view.content;

  writeFile(blogID, client, path, content, compare, callback);
}

function writeFile(blogID, client, path, content, compare, callback) {
  if (shouldIgnoreFile(path)) {
    // Silently skip ignored files to avoid breaking legacy templates
    // that may have ignored files in their stored views
    return callback();
  }

  if (typeof compare === "function") {
    callback = compare;
    compare = true;
  }

  var absolute = localPath(blogID, path);

  function finish(err) {
    if (err) return callback(err);

    fs.outputFile(absolute, content, callback);
  }

  if (!compare) return client.write(blogID, path, content, finish);

  fs.readFile(absolute, "utf-8", function (err, existing) {
    if (!err && existing === content) return callback();
    client.write(blogID, path, content, finish);
  });
}

function writeTemplateContents(
  blogID,
  client,
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

  writePackage(blogID, client, dir, metadata, views, compare, function (err) {
    if (err) {
      return callback(err);
    }

    async.eachOfSeries(
      views,
      function (view, name, next) {
        if (!view || !view.name || !view.content) return next();

        write(blogID, client, dir, view, compare, function (err) {
          if (!err && written) written.add(normalizePath(view.name));
          next(err);
        });
      },
      function (err) {
        if (err) return callback(err);

        if (written) {
          removeOrphanedFiles(
            blogID,
            client,
            dir,
            existingFiles,
            written,
            callback
          );
        } else {
          callback();
        }
      }
    );
  });
}

function listLocalFiles(blogID, dir, callback) {
  var root = localPath(blogID, dir);

  fs.readdir(root, function (err, entries) {
    if (err) {
      if (err.code === "ENOENT" || err.code === "ENOTDIR") return callback(null, []);
      return callback(err);
    }

    var files = [];

    async.each(
      entries.filter(function (entry) {
        return !shouldIgnoreFile(entry);
      }),
      function (entry, next) {
        walk(joinpath(root, entry), entry, next);
      },
      function (err) {
        if (err) return callback(err);
        callback(null, files.map(normalizePath));
      }
    );

    function walk(fullPath, relativePath, next) {
      if (shouldIgnoreFile(relativePath)) return next();

      fs.lstat(fullPath, function (err, stat) {
        if (err) {
          if (err.code === "ENOENT") return next();
          return next(err);
        }

        if (stat.isSymbolicLink()) return next();

        if (stat.isDirectory()) {
          fs.readdir(fullPath, function (err, children) {
            if (err) {
              if (err.code === "ENOENT") return next();
              return next(err);
            }

            async.each(
              children.filter(function (child) {
                return !shouldIgnoreFile(joinpath(relativePath, child));
              }),
              function (child, childNext) {
                walk(joinpath(fullPath, child), joinpath(relativePath, child), childNext);
              },
              next
            );
          });
        } else {
          if (/[\\/]/.test(relativePath)) return next();
          if (shouldIgnoreFile(relativePath)) return next();
          files.push(relativePath);
          next();
        }
      });
    }
  });
}

function removeOrphanedFiles(blogID, client, dir, existingFiles, written, callback) {
  var toRemove = existingFiles.filter(function (file) {
    return !written.has(normalizePath(file));
  });

  async.eachSeries(
    toRemove,
    function (file, next) {
      var relativePath = joinpath(dir, file);
      var absolutePath = localPath(blogID, relativePath);

      client.remove(blogID, relativePath, function (err) {
        if (err && err.code !== "ENOENT") return next(err);

        fs.remove(absolutePath, function (fsErr) {
          if (fsErr && fsErr.code !== "ENOENT") return next(fsErr);
          next();
        });
      });
    },
    callback
  );
}

function normalizePath(path) {
  return typeof path === "string" ? path.split(sep).join("/") : path;
}

function badPermission (blogID, templateID) {
  return new Error("No permission for " + blogID + " to write " + templateID);
}

function noTemplate (blogID, templateID) {
  return new Error("No template for " + blogID + " and " + templateID);
}

module.exports = withFolderLock(writeToFolderUnlocked);
