var Entry = require("models/entry");
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
var builds = require("./builds");
var isRedisUnavailableError =
  require("helper/redisUnavailable").isRedisUnavailableError;

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

module.exports = async function rebuildDependents(blogID, path) {
  const log = function () {
    console.log.apply(null, [
      clfdate(),
      blogID.slice(0, 12),
      "rebuildDependents:",
      path,
      ...arguments,
    ]);
  };

  // While a sync builds several files at once, the builds running now
  // may have read the folder and Redis before this path was saved, and
  // may record their dependency on it only after the set below is read
  const earlier = builds.concurrent(blogID) ? builds.running(blogID) : [];

  const blog = await Blog.get({ id: blogID });

  if (!blog) throw new Error("No blog");

  // Dependents are stored under a lowercased key so a file which
  // arrives with different casing than the link that missed it still
  // matches.
  const dependent_paths = await client.sMembers(dependentsKey(blogID, path));

  for (const dependent_path of dependent_paths) {
    await rebuildDependent(blog, dependent_path, log);
  }

  // So once those builds have finished, rebuild any dependents they
  // added. Not waited for here, so this file's update can finish, but
  // the batch waits for it (see builds.js).
  if (earlier.length) {
    builds.track(blogID, recheck(blog, path, earlier, dependent_paths, log));
  }

  await markTemplateDependents(blog.id, path, log);
};

// Nothing waits for it but the batch, so it only rejects with a Redis
// outage, which fails the batch (see builds.js): the client then keeps its
// place and the next sync applies these changes again
async function recheck(blog, path, earlier, rebuilt, log) {
  try {
    await Promise.all(earlier);

    const now = await client.sMembers(dependentsKey(blog.id, path));

    for (const dependent_path of now) {
      if (rebuilt.indexOf(dependent_path) > -1) continue;
      log("Rebuilding dependent added during the batch:", dependent_path);
      await rebuildDependent(blog, dependent_path, log);
    }
  } catch (err) {
    if (isRedisUnavailableError(err)) throw err;
    log("Error rebuilding dependents added during the batch:", err);
  }
}

async function rebuildDependent(blog, dependent_path, log) {
  // A failed read is the same as no entry
  const entry = await Entry.get(blog.id, dependent_path).catch(() => undefined);

  if (!entry) {
    log("No entry for dependent_path:", dependent_path);
    return;
  }

  // Folder posts are rebuilt through their source folder, see
  // rebuildEntry. In a concurrent sync this waits for any other
  // build of the same entry (see builds.js).
  await builds.queue(blog.id, entry.path, async function () {
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
          await dropDependent(blog.id, dependent_path);
        } catch (dropErr) {
          log("Error dropping invalid dependent:", dependent_path, dropErr);
        }
      }
    }
  });
}

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
