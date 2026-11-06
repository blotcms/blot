var async = require("async");
var Entry = require("models/entry");
var withCallback = require("helper/withCallback");
var client = require("models/client");
var Blog = require("models/blog");
var dependentsKey = Entry.key.dependents;
var templateKey = require("models/template/key");
var templateDependentsKey = templateKey.templateDependents;
var templateManifestsPendingKey = templateKey.templateManifestsPending;
const clfdate = require("helper/clfdate");
var Preview = require("./preview");
var isHidden = require("build/prepare/isHidden");
var isUnsafeFolderPostPreview = require("./isUnsafeFolderPostPreview");
var rebuildEntry = require("./rebuildEntry");

var NO_LONGER_VALID_ERRORS = [
  "WRONGTYPE",
  "ENOENT",
  "EMPTY",
  "ENOTDIR",
  "EISDIR",
  "TOO_MANY_FILES",
];

// The purpose of this module is to rebuild any
// entries already in the user's folder which depend
// on the contents of this particular file which was
// just changed or removed, and to mark any template which
// links to it for a CDN manifest update at the end of the sync.

module.exports = function (blogID, path, callback) {
  const log = function () {
    console.log.apply(null, [
      clfdate(),
      blogID.slice(0, 12),
      "rebuildDependents:",
      path,
      ...arguments,
    ]);
  };
  Blog.get({ id: blogID }, function (err, blog) {
    if (err || !blog) return callback(err || new Error("No blog"));
    (async function () {
      try {
        // Dependents are stored under a lowercased key so a file which
        // arrives with different casing than the link that missed it still
        // matches.
        const dependent_paths = await client.sMembers(
          dependentsKey(blogID, path)
        );

        async.eachSeries(
          dependent_paths,
          function (dependent_path, next) {
            // A failed read is the same as no entry
            withCallback(Entry.get)(
              blogID,
              dependent_path,
              function (err, entry) {
                if (!entry) {
                  log("No entry for dependent_path:", dependent_path);
                  return next();
                }

                // Folder posts are rebuilt through their source folder, see
                // rebuildEntry.
                rebuildEntry(blog, entry, function (err) {
                  if (err) {
                    // The dependent's own source file is gone, usually deleted
                    // in the same batch as this file. Dropping it below is the
                    // whole fix, so don't report it as an error.
                    if (isMissingFile(err)) {
                      log("Dependent no longer exists:", dependent_path);
                    } else {
                      log(
                        "Error rebuilding dependent_path:",
                        dependent_path,
                        err
                      );
                    }

                    if (shouldDropDependent(err)) {
                      dropDependent(blogID, dependent_path, function (dropErr) {
                        if (dropErr)
                          log(
                            "Error dropping invalid dependent:",
                            dependent_path,
                            dropErr
                          );
                        next();
                      });
                    } else {
                      next();
                    }

                    return;
                  }

                  next();
                });
              }
            );
          },
          function (err) {
            if (err) return callback(err);

            markTemplateDependents(blog.id, path, log).then(function () {
              callback();
            });
          }
        );
      } catch (err) {
        callback(err);
      }
    })();
  });
};

// Templates link to files in the blog's folder with {{#cdn}}. Their CDN
// manifest holds each file's versioned URL, so when the file changes, appears
// or goes away the manifest has to be regenerated. That is expensive (every
// folder target is re-hashed and CSS views are re-rendered), so it is not done per
// file: the templates are only marked as pending here, and sync/index.js
// regenerates each once when the sync finishes (see
// regenerateTemplateManifests), where the blog's cacheID is also bumped.
// Errors are logged and never fail the sync of the file itself.
async function markTemplateDependents(blogID, path, log) {
  try {
    const templateIDs = await client.sMembers(
      templateDependentsKey(blogID, path)
    );

    if (templateIDs && templateIDs.length) {
      await client.sAdd(templateManifestsPendingKey(blogID), templateIDs);
    }
  } catch (err) {
    log("Error marking template dependents", err);
  }
}

function isMissingFile(err) {
  return !!err && (err.code === "ENOENT" || err.name === "NotFoundError");
}

function shouldDropDependent(err) {
  if (!err) return false;

  var code = err.code || err.cause || "";

  if (typeof code === "string") {
    code = code.toString().toUpperCase();
    return NO_LONGER_VALID_ERRORS.indexOf(code) !== -1;
  }

  return false;
}

function dropDependent(blogID, path, callback) {
  // A failed read is the same as no entry
  withCallback(Entry.get)(blogID, path, function (getErr, entry) {
    if (!entry) return callback();

    Entry.drop(blogID, path, function (err) {
      if (err) return callback(err);

      // Same guard as set.js: never remove a filesystem preview for a draft
      // folder post outside /drafts/, where its path maps to a bare
      // "/album.html" that could be the user's real sibling source file.
      if (
        entry.draft &&
        !isHidden(path) &&
        !isUnsafeFolderPostPreview(path, entry.html)
      ) {
        Preview.remove(blogID, path, callback);
      } else {
        callback();
      }
    });
  });
}
