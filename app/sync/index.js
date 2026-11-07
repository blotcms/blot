const buildFromFolder = require("models/template").buildFromFolder;
const Blog = require("models/blog");
const Update = require("./update");
const renames = require("./renames");
const { take } = require("./hold");
const messenger = require("./messenger");
const previewReload = require("helper/publishPreviewReload");
const regenerateTemplateManifests = require("./update/regenerateTemplateManifests");
const readOnly = require("helper/readOnly");
const {
  addPendingSync,
  removePendingSync,
  addPendingUpdate,
  removePendingUpdate,
} = require("./lock-diagnostics-state");

function sync(blogID, callback) {
  if (typeof blogID !== "string") {
    throw new TypeError("Expected blogID with type:String as first argument");
  }

  if (typeof callback !== "function") {
    throw new TypeError(
      "Expected callback with type:Function as second argument"
    );
  }

  // While the data directory is read-only, wait rather than fail, so the
  // sync runs as soon as the freeze lifts. Nothing is held while waiting,
  // and the blog is loaded afterwards so the sync sees current settings.
  readOnly.whenWritable("sync " + blogID).then(
    () => start(blogID, callback),
    (err) => callback(err)
  );
}

function start(blogID, callback) {
  Blog.get({ id: blogID }, async function (err, blog) {
    if (err || !blog || !blog.id || blog.isDisabled) {
      return callback(new Error("Cannot sync blog " + blogID));
    }

    const { log, status, syncID } = messenger(blog);

    log("Starting sync");

    let release;
    let lockAcquiredAt;

    try {
      log("Acquiring lock on folder");

      // Resolves to null if the data directory became read-only between
      // the check in sync() and taking the lock (hold.js has released it
      // again): wait for the freeze to lift and start over.
      const lock = await take(blogID, {
        syncID,
        acquiredAt: () => lockAcquiredAt,
      });

      if (!lock) {
        log("Data directory became read-only, waiting");
        return sync(blogID, callback);
      }

      release = lock.release;
      lockAcquiredAt = Date.now();
      addPendingSync(blogID, syncID);
      log("Successfully acquired lock on folder");
    } catch (e) {
      log("Failed to acquire lock on folder");
      return callback(new Error("Failed to acquire folder lock"));
    }

    // we want to know if folder.update or folder.rename is called
    let changes = false;
    let _update = new Update(blog, log, status);
    const originalUpdate = _update;
    _update = function (path, callback) {
      if (typeof callback !== "function") {
        return originalUpdate.apply(originalUpdate, arguments);
      }
      addPendingUpdate(blogID, syncID, path);
      let called = false;
      const wrappedCallback = function () {
        if (!called) {
          called = true;
          removePendingUpdate(blogID, syncID, path);
        }
        return callback.apply(this, arguments);
      };
      return originalUpdate.call(originalUpdate, path, wrappedCallback);
    };
    // There is no path to the blog's folder here: clients read and write it
    // through storage/folder, by blogID
    // An update which calls back { changed: false } built exactly the entry
    // already stored (see update/index.js), so it needs no cacheID bump. Any
    // other outcome, or an update without a callback, counts as a change.
    const folder = {
      update: function (path, callback) {
        if (typeof callback !== "function") {
          changes = true;
          return _update.apply(_update, arguments);
        }

        _update(path, function (err, result) {
          if (err || !result || result.changed !== false) changes = true;
          return callback.apply(this, arguments);
        });
      },
      status,
      log,
    };

    // We acquired a lock on the resource!
    // This function is to be called when we are finished
    // with the lock on the user's folder.
    folder.status("Syncing");

    // Pass methods to trigger folder updates back to the
    // function which wanted to modify the blog's folder.
    callback(null, folder, function (syncError, callback) {
      log("Sync callback invoked");
      removePendingSync(blogID, syncID);
      folder.status("Synced");

      if (typeof syncError === "function")
        throw new Error("Pass an error or null as first argument to done");

      if (typeof callback !== "function")
        throw new Error("Pass a callback to done");

      log("Checking for renamed files");
      // The rest of the sync runs from the end of this chain, as it did from
      // the callback: a throw below is an unhandled rejection, which exits the
      // process and so releases the folder lock.
      renames(blogID)
        .then(
          () => null,
          (err) => err
        )
        .then(async function (err) {
          if (err) {
            folder.status("Error checking file renames");
            log("Error checking file renames");
            console.log(err);
          }

          log("Building templates from folder");
          let buildError = null;
          try {
            await buildFromFolder(blogID);
          } catch (err) {
            buildError = err;
          }

          if (buildError) {
            folder.status("Error building templates from folder");
            log("Error building templates in folder");
            console.log(buildError);
          }

          // Templates which link to files that changed in this sync have
          // their CDN manifest regenerated once, now, rather than once per
          // file (see update/rebuildDependents). The blog's cacheID is
          // bumped below, as for any sync with changes.
          log("Updating CDN manifests of templates");
          try {
            const updated = await regenerateTemplateManifests(blogID, {
              log,
            });

            if (updated) changes = true;
          } catch (manifestError) {
            log(
              "Error updating CDN manifests of templates",
              manifestError.message
            );
          }

          // We could do these next two things in parallel
          // but it's a little bit of refactoring...
          log("Releasing lock");
          let releaseError = null;
          try {
            await release();
            log("Finished sync");
          } catch (err) {
            // Redis unreachable or the lock was already lost. Never leave
            // the caller's callback pending; surface the failure instead.
            // The folder still changed, so the cacheID must still be bumped.
            log("Failed to release lock", err.message);
            releaseError = err;
          }

          if (!changes) {
            return callback(syncError || releaseError);
          }

          // If Redis is unavailable the bump is retried in the background,
          // and the preview reloaded again once it lands
          log("Updating cacheID of blog");
          Blog.bumpCacheID(
            blogID,
            function (err) {
              if (err) {
                log("Error updating cacheID of blog");
              }

              previewReload.publish(blogID);

              callback(syncError || releaseError);
            },
            function () {
              previewReload.publish(blogID);
            }
          );
        });
    });
  });
}

module.exports = sync;
