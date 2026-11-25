const buildFromFolder = require("models/template").buildFromFolder;
const Blog = require("models/blog");
const Update = require("./update");
const renames = require("./renames");
const { isTemplatePath } = require("./update/set");
const pathNormalizer = require("helper/pathNormalizer");
const folderRenames = require("models/template/folderRenames");
const templateKey = require("models/template/key");
const client = require("models/client");
const { take } = require("./hold");
const messenger = require("./messenger");
const previewReload = require("helper/publishPreviewReload");
const regenerateTemplateManifests = require("./update/regenerateTemplateManifests");
const dependents = require("./update/dependents");
const readOnly = require("helper/readOnly");
const logContext = require("helper/logContext");
const guard = require("storage/folder/guard");
const {
  addPendingSync,
  removePendingSync,
  addPendingUpdate,
  removePendingUpdate,
} = require("./lock-diagnostics-state");

// How long the templates-need-building key lasts if nothing clears it
const NEEDS_BUILD_TTL_SECONDS = 60 * 60 * 24 * 90;
const ALL_TEMPLATES = Symbol("all templates");

// The lowercased name of the template directory a path in the templates
// folder is in or is, e.g. "blog" for /Templates/Blog/entry.html, or null for
// the templates folder itself or the root, which may hold every template
function templateDirName(path) {
  const parts = pathNormalizer(path).toLowerCase().split("/");
  return parts[1] === "templates" && parts[2] ? parts[2] : null;
}

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
      result = await folder.run(() => fn(folder));
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
  let signal;
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
    signal = lock.signal;
    lockAcquiredAt = Date.now();
    addPendingSync(blogID, syncID);
    log("Successfully acquired lock on folder");
  } catch (err) {
    log("Failed to acquire lock on folder");
    throw new Error("Failed to acquire folder lock", { cause: err });
  }

  // we want to know if folder.update or folder.rename is called
  let changes = false;
  // and whether any updated path was in the templates folder: the names of
  // the template directories updated (lowercased), or ALL_TEMPLATES when a
  // path could have changed every template (the folder itself, or the root)
  let templatesTouched = false;
  let touchedTemplates = new Set();
  // Resolves, once the first templates path has marked the templates as
  // needing a build, to { existed, marked }: whether the key was already set
  // before this sync, and whether setting it worked (see beforeRelease)
  let needsBuildMarked = null;
  const originalUpdate = new Update(blog, log, status);
  // The key is set before the first templates path is updated, not when the
  // sync ends: a deploy can kill the sync in between, after the client has
  // saved its cursor, and the next sync must still build the templates. Never
  // rejects: a failure is handled in beforeRelease.
  function markTemplatesNeedBuild() {
    if (needsBuildMarked) return needsBuildMarked;

    needsBuildMarked = (async function () {
      try {
        const [existed] = await client
          .multi()
          .exists(templateKey.needsBuild(blogID))
          .set(templateKey.needsBuild(blogID), "1", {
            EX: NEEDS_BUILD_TTL_SECONDS,
          })
          .exec();

        return { existed: Number(existed) > 0, marked: true };
      } catch (err) {
        log("Could not mark templates as needing a build", err.message);
        return { existed: true, marked: false };
      }
    })();

    return needsBuildMarked;
  }

  // How long after the change in the source a file went live: the update
  // bumps the blog's cacheID once it has saved a changed file (see
  // update/index.js), so the change is live when update resolves. options:
  //   modified  the source's own time for the change, ms since the epoch or
  //             an ISO string: Dropbox's server_modified, Drive's
  //             modifiedTime, the file's mtime on the macserver for iCloud,
  //             the committer time for Git
  //   since     which of those it is, for the log line
  // The lag includes the provider's delay in telling Blot, any wait for the
  // lock and the files built before this one in the same sync. Grep for
  // "live lag_ms=" to measure it.
  //
  // Where that time went, as far as is known, each from the source's time:
  //   seen_ms      when a change source first saw it (options.seenAt), and
  //   seen_by      which source (options.seenBy)
  //   lock_ms      when this sync took the folder lock (negative when it
  //                held the lock already before the change)
  //   download_ms  when the client had the file (options.downloadedAt)
  //   build_ms     how long the update itself took, not from the source's time
  // The rest of lag_ms is waiting between them.
  function logLag(path, options, updateStartedAt) {
    if (!options || options.modified === undefined) return;

    const modified =
      typeof options.modified === "string"
        ? Date.parse(options.modified)
        : Number(options.modified);

    if (!Number.isFinite(modified)) return;

    const since = (at) => (Number.isFinite(at) ? at - modified : null);
    const stages = [
      ["seen_ms", since(options.seenAt)],
      ["seen_by", options.seenBy || null],
      ["lock_ms", since(lockAcquiredAt)],
      ["download_ms", since(options.downloadedAt)],
      ["build_ms", Date.now() - updateStartedAt],
    ].filter(([, value]) => value !== null);

    log(
      path,
      `live lag_ms=${Date.now() - modified} since=${options.since || "modified"}`,
      ...stages.map(([name, value]) => `${name}=${value}`)
    );
  }

  // There is no path to the blog's folder here: clients read and write it
  // through storage/folder, by blogID
  // An update which resolves { changed: false } built exactly the entry
  // already stored (see update/index.js), so it needs no cacheID bump. Any
  // other outcome counts as a change. Each update is listed as pending for
  // lock-diagnostics until it settles. A client may pass the source's time
  // for the change as options.modified (see logLag).
  //
  // folder.signal aborts when seize() (./seize.js) wants the lock, e.g. for
  // a disconnect: the client should stop at its next check
  // (signal.throwIfAborted()), and pass the signal into its requests. From
  // then on update() throws the signal's reason, status() does nothing, and
  // so do writes to the folder from inside sync()'s fn or folder.run()
  // (storage/folder/guard.js).
  const folder = {
    signal,
    // Runs async fn() so that its writes to the folder throw once the signal
    // has aborted, as sync()'s fn does. For callers of establishSyncLock.
    run: (fn) => guard.run(blogID, signal, fn),
    update: async function update(path, options) {
      let result;

      signal.throwIfAborted();

      addPendingUpdate(blogID, syncID, path);
      if (isTemplatePath(path)) {
        templatesTouched = true;
        const name = templateDirName(path);
        if (name === null) touchedTemplates = ALL_TEMPLATES;
        else if (touchedTemplates !== ALL_TEMPLATES) touchedTemplates.add(name);
        await markTemplatesNeedBuild();
      }

      const updateStartedAt = Date.now();
      try {
        result = await originalUpdate(path);
      } catch (err) {
        removePendingUpdate(blogID, syncID, path);
        changes = true;
        throw err;
      }

      removePendingUpdate(blogID, syncID, path);
      if (!result || result.changed !== false) {
        changes = true;
        if (!result || !result.error) logLag(path, options, updateStartedAt);
      }
      return result;
    },
    status(...args) {
      if (!signal.aborted) status(...args);
    },
    log,
    // Rebuilds now what depends on the files this sync changed, as done()
    // does before it releases the lock: for a caller which answers a request
    // before calling done(), so the answer comes once the rebuild is over,
    // as it did when dependents were rebuilt with each file. Call it inside
    // folder.run. Never rejects.
    drainDependents,
  };

  // We acquired a lock on the resource!
  folder.status("Syncing");

  // Rebuilds, once each, what depends on the files changed in this sync or
  // left pending by one killed before its end (update/dependents.js).
  // Writes like any of the sync's, so they are refused once the signal has
  // aborted, and it stops between entries then. Never rejects.
  async function drainDependents() {
    const drainStartedAt = Date.now();

    try {
      const rebuilt = await guard.run(blogID, signal, () =>
        dependents.drain(blogID, {
          track: originalUpdate.track,
          signal,
          status: folder.status,
          log,
        })
      );

      if (rebuilt) {
        changes = true;
        log(
          "Rebuilt " +
            rebuilt +
            " dependent entries ms=" +
            (Date.now() - drainStartedAt)
        );
      }
    } catch (err) {
      log("Error rebuilding dependent entries", err.message);
    }
  }

  // Called once the caller is finished with the lock on the user's folder.
  // Rejects with syncError, or else with the error releasing the lock.
  async function done(syncError) {
    log("Sync callback invoked");
    removePendingSync(blogID, syncID);

    if (typeof syncError === "function")
      throw new Error("Pass an error or null as first argument to done");

    let releaseError = null;

    // The steps before the release log their own failures, so the lock is
    // released even if something unexpected throws
    try {
      // A cancelled sync gives the lock up straight away. The templates key
      // is set already (markTemplatesNeedBuild), so the next sync builds
      // them. A file it moved isn't paired up as a rename, so its entry
      // counts as new: only for a move in the seconds before a disconnect.
      if (!signal.aborted) await beforeRelease();
      else
        log(
          "Cancelled, skipping renames, templates, dependents and CDN manifests"
        );
      folder.status("Synced");
    } finally {
      // Before the release: a deploy's drain (helper/drain) lets the process
      // exit once it holds no folder locks, so a bump after the release could
      // be lost, leaving the site serving pages cached under the old cacheID.
      // The bump never throws, so the lock is still released.
      if (changes) await bumpCacheID();

      log("Releasing lock");
      try {
        await release();
        log("Finished sync");
      } catch (err) {
        // Redis unreachable or the lock was already lost. Never leave the
        // caller waiting; surface the failure instead.
        log("Failed to release lock", err.message);
        releaseError = err;
      }
    }

    if (syncError || releaseError) throw syncError || releaseError;
  }

  async function bumpCacheID() {
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

    // Never rejects; not waited for, as before
    previewReload.publish(blogID);
  }

  async function beforeRelease() {
    // A rename is a deleted entry and a created one, so a sync in which no
    // update changed anything has none to pair up
    if (changes) {
      log("Checking for renamed files");
      try {
        await renames(blogID);
      } catch (err) {
        folder.status("Error checking file renames");
        log("Error checking file renames");
        console.log(err);
      }
    }

    // Templates in the folder only change when a path in the templates folder
    // is updated. The exception is an installed template whose folder went
    // missing: buildFromFolder keeps it for a rename window and finishes
    // removing it in the first sync after, whichever paths that sync updates
    // (see models/template/folderRenames), so it runs while one is pending.
    //
    // A build which fails to read a template (Redis trouble, say) would not
    // be retried by the next sync, as the client has already saved its cursor,
    // so a path in the templates folder also leaves a key behind, which is
    // cleared only by a build which read every template it was asked to. The
    // key is set as the sync first updates such a path, so a sync killed
    // before it gets here (a deploy) leaves it too.
    //
    // A build reads only the templates whose directories this sync updated:
    // the others are as the last build left them. Every template is read
    // when the key above was already set, since a template that failed to be
    // read before may be one this sync didn't update, or when a path could
    // have changed all of them.
    let buildTemplates = templatesTouched;
    let readAll = touchedTemplates === ALL_TEMPLATES;

    if (templatesTouched) {
      // The key was set by the first templates path this sync updated (see
      // markTemplatesNeedBuild), so whether it was already set comes from
      // there. If setting it failed then, try again now.
      const { existed, marked } = await markTemplatesNeedBuild();

      if (!readAll) readAll = existed;

      if (!marked) {
        try {
          await client.set(templateKey.needsBuild(blogID), "1", {
            EX: NEEDS_BUILD_TTL_SECONDS,
          });
        } catch (err) {
          log("Could not mark templates as needing a build", err.message);
        }
      }
    } else {
      try {
        const pending = await folderRenames.readPending(blogID);
        readAll = (await client.exists(templateKey.needsBuild(blogID))) > 0;
        buildTemplates = readAll || Object.keys(pending).length > 0;
      } catch (err) {
        buildTemplates = true;
        readAll = true;
      }
    }

    if (buildTemplates) {
      log("Building templates from folder");
      try {
        const { failed } =
          (await buildFromFolder(
            blogID,
            readAll ? {} : { only: touchedTemplates }
          )) || {};

        if (!failed) {
          await client.del(templateKey.needsBuild(blogID));
        } else {
          log("Could not read " + failed + " template(s), will build again");
        }
      } catch (buildError) {
        folder.status("Error building templates from folder");
        log("Error building templates in folder");
        console.log(buildError);
      }
    }

    // After renames, which only pair up deletions from the last few seconds,
    // and the templates, before their CDN manifests
    log("Rebuilding dependent entries");
    await drainDependents();

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
module.exports.seize = require("./seize");
