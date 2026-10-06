var async = require("async");
var Entry = require("models/entry");
var client = require("models/client");
var Blog = require("models/blog");
var dependentsKey = Entry.key.dependents;
var dependentsExactCaseKey = Entry.key.dependentsExactCase;
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
// just changed or removed.

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
        // matches. Sets written before that are under the exact-case key
        // until their entries are rebuilt (scripts/entry/rebuild-all.js), so
        // check that too and merge.
        const keys = Array.from(
          new Set([
            dependentsKey(blogID, path),
            dependentsExactCaseKey(blogID, path),
          ])
        );
        const dependent_paths = Array.from(
          new Set(
            (await Promise.all(keys.map((key) => client.sMembers(key)))).flat()
          )
        );

        async.eachSeries(
          dependent_paths,
          function (dependent_path, next) {
            Entry.get(blogID, dependent_path, function (entry) {
              if (!entry) {
                log("No entry for dependent_path:", dependent_path);
                return next();
              }

              // Folder posts are rebuilt through their source folder, see
              // rebuildEntry.
              rebuildEntry(blog, entry, function (err) {
                if (err) {
                  log("Error rebuilding dependent_path:", dependent_path, err);

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
            });
          },
          callback
        );
      } catch (err) {
        callback(err);
      }
    })();
  });
};

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
  Entry.get(blogID, path, function (entry) {
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
