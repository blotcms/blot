var Entry = require("models/entry");
var promiseOnly = require("helper/promiseOnly");
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

module.exports = promiseOnly(async function rebuildDependents(blogID, path) {
  const log = function () {
    console.log.apply(null, [
      clfdate(),
      blogID.slice(0, 12),
      "rebuildDependents:",
      path,
      ...arguments,
    ]);
  };

  const blog = await Blog.get({ id: blogID });

  if (!blog) throw new Error("No blog");

  // Dependents are stored under a lowercased key so a file which
  // arrives with different casing than the link that missed it still
  // matches.
  const dependent_paths = await client.sMembers(dependentsKey(blogID, path));

  for (const dependent_path of dependent_paths) {
    // A failed read is the same as no entry
    const entry = await Entry.get(blogID, dependent_path).catch(
      () => undefined
    );

    if (!entry) {
      log("No entry for dependent_path:", dependent_path);
      continue;
    }

    // Folder posts are rebuilt through their source folder, see
    // rebuildEntry.
    try {
      await rebuildEntry(blog, entry);
    } catch (err) {
      // The dependent's own source file is gone, usually deleted
      // in the same batch as this file. Dropping it below is the
      // whole fix, so don't report it as an error.
      if (isMissingFile(err)) {
        log("Dependent no longer exists:", dependent_path);
      } else {
        log("Error rebuilding dependent_path:", dependent_path, err);
      }

      if (shouldDropDependent(err)) {
        try {
          await dropDependent(blogID, dependent_path);
        } catch (dropErr) {
          log("Error dropping invalid dependent:", dependent_path, dropErr);
        }
      }
    }
  }

  await markTemplateDependents(blog.id, path, log);
});

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

async function dropDependent(blogID, path) {
  // A failed read is the same as no entry
  const entry = await Entry.get(blogID, path).catch(() => undefined);

  if (!entry) return;

  await Entry.drop(blogID, path);

  // Same guard as set.js: never remove a filesystem preview for a draft
  // folder post outside /drafts/, where its path maps to a bare
  // "/album.html" that could be the user's real sibling source file.
  if (
    entry.draft &&
    !isHidden(path) &&
    !isUnsafeFolderPostPreview(path, entry.html)
  ) {
    await Preview.remove(blogID, path);
  }
}
