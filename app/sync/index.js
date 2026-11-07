const buildFromFolder = require("models/template").buildFromFolder;
const Blog = require("models/blog");
const Update = require("./update");
const renames = require("./renames");
const { take } = require("./hold");
const messenger = require("./messenger");
const previewReload = require("helper/publishPreviewReload");
const regenerateTemplateManifests = require("./update/regenerateTemplateManifests");
const readOnly = require("helper/readOnly");
const logContext = require("helper/logContext");
const {
  addPendingSync,
  removePendingSync,
  addPendingUpdate,
  removePendingUpdate,
} = require("./lock-diagnostics-state");

// Runs async fn(folder) while holding the blog's folder lock, then finishes
// the sync (renames, templates, CDN manifests, releasing the lock, the cacheID
// bump) whether fn resolved or threw. Resolves to what fn resolved to, or
// rejects with what fn threw (or else with the error releasing the lock).
// Rejects without calling fn if the sync cannot start: "Cannot sync blog <id>"
// (a missing or disabled blog) or "Failed to acquire folder lock" (another
// sync holds it).
//
//   const result = await sync(blogID, async function (folder) {
//     await folder.update(path);
//     return result;
//   });
function sync(blogID, fn) {
  checkBlogID(blogID);

  if (typeof fn !== "function") {
    throw new TypeError("Expected fn with type:Function as second argument");
  }

  // Lines the sync logs, here and in the client and code it calls, carry
  // its blog and sync id (helper/logContext)
  return logContext.run({ blog: blogID }, async function () {
    const { folder, done } = await acquire(blogID);
    let result;

    try {
      result = await fn(folder);
    } catch (err) {
      await done(err);
      throw err;
    }

    await done(null);
    return result;
  });
}

// For callers which finish the sync somewhere other than the function that
// took the lock. Resolves to { folder, done }, or rejects as sync() does.
// Call await done(err) once: it finishes the sync as sync() does, then
// rejects with err (or else with the error releasing the lock) or resolves.
async function establishSyncLock(blogID) {
  checkBlogID(blogID);
  return logContext.run({ blog: blogID }, () => acquire(blogID));
}

function checkBlogID(blogID) {
  if (typeof blogID !== "string") {
    throw new TypeError("Expected blogID with type:String as first argument");
  }
}

// Runs in the sync's logContext
async function acquire(blogID) {
  // While the data directory is read-only, wait rather than fail, so the
  // sync runs as soon as the freeze lifts. Nothing is held while waiting,
  // and the blog is loaded afterwards so the sync sees current settings.
  await readOnly.whenWritable("sync " + blogID);

  let blog;

  try {
    blog = await Blog.get({ id: blogID });
  } catch (err) {
    blog = null;
  }

  if (!blog || !blog.id || blog.isDisabled) {
    throw new Error("Cannot sync blog " + blogID);
  }

  const { log, status, syncID } = messenger(blog);
  logContext.set({ sync: syncID });

  log("Starting sync");

  let release;
  let lockAcquiredAt;

  try {
    log("Acquiring lock on folder");

    // Resolves to null if the data directory became read-only between
    // the check above and taking the lock (hold.js has released it
    // again): wait for the freeze to lift and start over.
    const lock = await take(blogID, {
      syncID,
      acquiredAt: () => lockAcquiredAt,
    });

    if (!lock) {
      log("Data directory became read-only, waiting");
      return acquire(blogID);
    }

    release = lock.release;
    lockAcquiredAt = Date.now();
    addPendingSync(blogID, syncID);
    log("Successfully acquired lock on folder");
  } catch (err) {
    log("Failed to acquire lock on folder");
    throw new Error("Failed to acquire folder lock", { cause: err });
  }

  // we want to know if folder.update or folder.rename is called
  let changes = false;
  const originalUpdate = new Update(blog, log, status);
  // There is no path to the blog's folder here: clients read and write it
  // through storage/folder, by blogID
  // An update which resolves { changed: false } built exactly the entry
  // already stored (see update/index.js), so it needs no cacheID bump. Any
  // other outcome counts as a change. Each update is listed as pending for
  // lock-diagnostics until it settles.
  const folder = {
    update: async function update(path) {
      let result;

      addPendingUpdate(blogID, syncID, path);

      try {
        result = await originalUpdate(path);
      } catch (err) {
        removePendingUpdate(blogID, syncID, path);
        changes = true;
        throw err;
      }

      removePendingUpdate(blogID, syncID, path);
      if (!result || result.changed !== false) changes = true;
      return result;
    },
    status,
    log,
  };

  // We acquired a lock on the resource!
  folder.status("Syncing");

  // Called once the caller is finished with the lock on the user's folder.
  // Rejects with syncError, or else with the error releasing the lock.
  async function done(syncError) {
    log("Sync callback invoked");
    removePendingSync(blogID, syncID);
    folder.status("Synced");

    if (typeof syncError === "function")
      throw new Error("Pass an error or null as first argument to done");

    let releaseError = null;

    // The steps before the release log their own failures, so the lock is
    // released even if something unexpected throws
    try {
      await beforeRelease();
    } finally {
      // We could do these next two things in parallel
      // but it's a little bit of refactoring...
      log("Releasing lock");
      try {
        await release();
        log("Finished sync");
      } catch (err) {
        // Redis unreachable or the lock was already lost. Never leave the
        // caller waiting; surface the failure instead. The folder still
        // changed, so the cacheID must still be bumped.
        log("Failed to release lock", err.message);
        releaseError = err;
      }
    }

    if (changes) {
      // If Redis is unavailable the bump is retried in the background,
      // and the preview reloaded again once it lands
      log("Updating cacheID of blog");
      try {
        await Blog.bumpCacheID(blogID, function () {
          previewReload.publish(blogID);
        });
      } catch (err) {
        log("Error updating cacheID of blog");
      }

      previewReload.publish(blogID);
    }

    if (syncError || releaseError) throw syncError || releaseError;
  }

  async function beforeRelease() {
    log("Checking for renamed files");
    try {
      await renames(blogID);
    } catch (err) {
      folder.status("Error checking file renames");
      log("Error checking file renames");
      console.log(err);
    }

    log("Building templates from folder");
    try {
      await buildFromFolder(blogID);
    } catch (buildError) {
      folder.status("Error building templates from folder");
      log("Error building templates in folder");
      console.log(buildError);
    }

    // Templates which link to files that changed in this sync have
    // their CDN manifest regenerated once, now, rather than once per
    // file (see update/rebuildDependents). The blog's cacheID is
    // bumped by done, as for any sync with changes.
    log("Updating CDN manifests of templates");
    try {
      const updated = await regenerateTemplateManifests(blogID, {
        log,
      });

      if (updated) changes = true;
    } catch (manifestError) {
      log("Error updating CDN manifests of templates", manifestError.message);
    }
  }

  return { folder, done };
}

module.exports = sync;
module.exports.establishSyncLock = establishSyncLock;
