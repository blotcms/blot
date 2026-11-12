const storage = require("storage/folder");
const { join, extname } = require("path");
const clfdate = require("helper/clfdate");
const download = require("../util/download");
const {
  MAX_FILE_SIZE,
  hasUnsupportedExtension,
  isDotfileOrDotfolder,
  transferIncomplete,
} = require("../util/constants");
const modifiedSince = require("./modified-since");
const { deletedSince } = modifiedSince;
const shouldIgnoreFile = require("clients/util/shouldIgnoreFile");
const localDescendants = require("clients/util/localDescendants");
const {
  countLocalFiles,
  createProgress,
} = require("clients/util/resyncProgress");

const set = (...args) => require("../database").set(...args);
const persistError = require("../util/persistError");
const {
  SOURCES,
  classify,
  dropboxTag,
  keepsErrorAfterDownload,
} = require("../util/classifyError");
const tagSource = require("../util/tagSource");
const retryRequest = require("../util/retryRequest");
const loadClient = require("../util/loadClient");
const createClient = async (blogID) => {
  const { error, client, account } = await loadClient(blogID);
  if (error) throw error;
  return [client, account];
};

// Caps how many files in one directory are hashed/stat'd at once. Without
// this, a directory with thousands of files fires that many concurrent
// streaming sha256 hashes (helper/hashFile) in one Promise.all, and the
// resulting callback/GC volume can stall the event loop long enough to blow
// through the folder lock's TTL (app/sync/lock.js) and crash the process.
const HASH_CONCURRENCY = 10;

async function mapLimit(items, limit, iterator) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await iterator(items[index], index);
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

// update(path) is called as each file or directory changes on disk, so the
// database follows the folder even if the walk fails part way through. It is
// the same (blogID, publish, update) contract the iCloud and Drive clients
// use, and callers should hold the folder lock while it runs.
async function resetToBlot(blogID, publish, update) {
  if (!publish)
    publish = (...args) => {
      console.log(clfdate() + " Dropbox:", args.join(" "));
    };

  const updatePath = async (path) => {
    if (typeof update !== "function") return;
    try {
      await update(path);
    } catch (err) {
      publish("Failed to update", path, err.message);
    }
  };

  // Files Dropbox modified after this moment may just be edits that
  // landed mid-walk (before their webhook), not changes we failed to sync.
  const startedAt = Date.now();

  publish("Syncing folder from Dropbox to Blot");

  let client, account;
  try {
    [client, account] = await createClient(blogID);
  } catch (err) {
    await persistError(blogID, err, SOURCES.AUTH);
    throw err;
  }

  try {
    return await resetToBlotWithClient(
      blogID,
      publish,
      client,
      account,
      updatePath,
      startedAt
    );
  } catch (err) {
    await persistError(blogID, err, SOURCES.APPLY);
    throw err;
  }
}

async function resetToBlotWithClient(
  blogID,
  publish,
  client,
  account,
  updatePath,
  startedAt
) {
  // Guard this at the source rather than only in each caller: resetToBlot
  // treats Dropbox as the source of truth and deletes any local file with no
  // Dropbox counterpart (see the walk below), which is exactly wrong while
  // the initial transfer to Dropbox (reset-from-blot.js, run during setup)
  // hasn't finished - those are exactly the files that would get wrongly
  // deleted. init.js's resetToBlotWithLock, the manual "Resync from Dropbox"
  // dashboard action, and the scripts/dropbox/*.js CLI tools all end up
  // here, so checking once here (before touching anything, fs or Dropbox)
  // covers every caller instead of relying on each of them to check first.
  if (transferIncomplete(account)) {
    const error = new Error(
      "Dropbox hasn't finished receiving this blog's initial transfer yet, so it can't be treated as the source of truth without risking deleting files that were never uploaded. Free up space in Dropbox (if that's the issue) and retry the transfer from the Dropbox settings page, or disconnect, then try again."
    );
    error.code = "DROPBOX_TRANSFER_INCOMPLETE";
    throw error;
  }

  let dropboxRoot = "/";

  // Load the path to the blog folder root position in Dropbox
  if (account.folder_id) {
    const { result } = await tagSource(
      SOURCES.DELTA,
      retryRequest(
        () => client.filesGetMetadata({ path: account.folder_id }),
        "filesGetMetadata"
      )
    );
    const { path_display } = result;
    if (path_display) {
      dropboxRoot = path_display;
      await set(blogID, { folder: path_display });
    }
  }

  // It's import that these args match those used in delta.js
  // A way to quickly get a cursor for the folder's state.
  // From the docs:
  // https://dropbox.github.io/dropbox-sdk-js/Dropbox.html
  // Unlike list_folder, list_folder/get_latest_cursor doesn't
  // return any entries. This endpoint is for app which only
  // needs to know about new files and modifications and doesn't
  // need to know about files that already exist in Dropbox.
  // Route attributes: scope: files.metadata.read

  const {
    result: { cursor },
  } = await tagSource(
    SOURCES.DELTA,
    retryRequest(
      () =>
        client.filesListFolderGetLatestCursor({
          path: account.folder_id || "",
          include_deleted: true,
          recursive: true,
        }),
      "filesListFolderGetLatestCursor"
    )
  );

  // The cursor is fetched before the walk, so edits made during it are still
  // seen by the next sync, but only saved once the walk succeeds. If the walk
  // throws, the old cursor stays and the next webhook can still see those files.

  const summary = {
    downloaded: 0,
    removed: 0,
    createdDirs: 0,
    skipped: 0,
    // Files that could not be downloaded or removed. The walk carries on past
    // them, so without this a partial walk looks like a complete one; the
    // hourly sweep reports it as a walk error. firstError is a sample.
    failed: 0,
    firstError: null,
    // Subset of downloaded: files Dropbox modified after we started.
    modifiedDuringWalk: 0,
    // Changes (of any kind) that Dropbox shows were made during the walk or
    // just before it (see GRACE_MS): paths it reports changing since the
    // pre-walk cursor, or whose deletion or contents are timestamped recently.
    // Not counted by countChanges, like modifiedDuringWalk. See
    // excuseRecentChanges below.
    changedDuringWalk: 0,
    // Paths behind downloaded/removed/createdDirs not already excused by
    // modifiedDuringWalk, checked once the walk is done.
    changedPaths: [],
    // Removals and folders carry no timestamp in a folder listing, so these
    // give excuseRecentChanges something to timestamp them by:
    // removedFiles maps a removed path to up to MAX_REMOVED_SAMPLES file paths
    // on Blot that were removed with it (itself, for a file), whose deletion
    // time list_revisions can give; modifiedPaths are the downloaded files
    // modifiedSince excused, which date the folders created for them.
    removedFiles: {},
    modifiedPaths: [],
    startedAt,
    // Subfolders Dropbox could no longer list, as { dir, tag } (see walk)
    vanished: [],
  };

  const progress = createProgress(await countLocalFiles(blogID, "/"), publish);

  await walk(
    blogID,
    client,
    publish,
    updatePath,
    dropboxRoot,
    "/",
    summary,
    progress
  );

  const changed =
    summary.changedPaths.length || summary.vanished.length
      ? await changedSinceCursor(client, cursor, dropboxRoot)
      : null;

  // A subfolder Dropbox listed in its parent but then said isn't one was
  // deleted, moved or replaced by a file since. If Dropbox reports it as
  // changed since the pre-walk cursor, that's a live edit: leave Blot's copy
  // alone, since the catch-up sync applies it from that cursor (as a move,
  // where the walk could only remove and download). Otherwise the 409 is
  // unexplained, so report it as a failed path rather than hide it.
  for (const { dir, tag } of summary.vanished) {
    if (changed && overlapsAny(dir, changed)) {
      publish("Skipping", dir, "which changed in Dropbox during the walk");
      summary.skipped += 1;
    } else {
      publish("Failed to list", dir, tag);
      recordFailure(summary, dir, new Error("409 " + tag));
    }
  }

  if (summary.changedPaths.length) {
    await excuseRecentChanges(client, changed, dropboxRoot, summary);
    if (summary.changedDuringWalk)
      publish(
        `${summary.changedDuringWalk} change(s) were made in Dropbox during or just before the walk`
      );
  }

  // This means that future syncs will be fast
  // A download-only pass can't show that Dropbox has room for uploads,
  // so it leaves a quota error in place.
  await set(
    blogID,
    keepsErrorAfterDownload(account) ? { cursor } : { cursor, error_code: 0 }
  );

  progress.finish("Finished processing folder");

  return summary;
}

function recordFailure(summary, path, err) {
  summary.failed += 1;
  if (!summary.firstError) summary.firstError = path + ": " + err.message;
}

const walk = async (
  blogID,
  client,
  publish,
  updatePath,
  dropboxRoot,
  dir,
  summary,
  progress
) => {
  publish("Checking", dir);
  const remoteReading = remoteReaddir(client, join(dropboxRoot, dir)).catch(
    (err) => {
      if (dir === "/" || !vanishedFolder(err)) throw err;
      summary.vanished.push({ dir, tag: dropboxTag(err) });
      return null;
    }
  );
  const [remoteContents, localContents] = await Promise.all([
    remoteReading,
    localReaddir(blogID, dir, remoteReading),
  ]);

  // Dropbox no longer has this folder: remove nothing, and check once the
  // walk is done whether the cursor explains it (see resetToBlotWithClient)
  if (!remoteContents) return;

  for (const { name, path_display, is_directory } of localContents) {
    const pathOnBlot = join(dir, name);
    // A directory removed in one fs.remove call still accounts for every
    // file total counted inside it, so current must advance by that many.
    const removedCount = is_directory
      ? await countLocalFiles(blogID, pathOnBlot)
      : 1;

    if (shouldIgnoreFile(pathOnBlot)) {
      progress.publish("Removing ignored", pathOnBlot, false, removedCount);
      try {
        await storage.remove(blogID, pathOnBlot);
        summary.removed += 1;
        await updatePath(pathOnBlot);
      } catch (e) {
        publish("Failed to remove ignored", path_display, e.message);
        recordFailure(summary, pathOnBlot, e);
      }
      continue;
    }

    const remoteCounterpart = remoteContents.find(
      (remoteItem) => remoteItem.name === name
    );

    if (!remoteCounterpart) {
      progress.publish("Removing", pathOnBlot, false, removedCount);
      try {
        const descendants = is_directory
          ? await localDescendants(blogID, pathOnBlot)
          : [];
        // Before the removal, while there is something left to stat
        summary.removedFiles[pathOnBlot] = is_directory
          ? await sampleFiles(blogID, descendants)
          : [pathOnBlot];
        await storage.remove(blogID, pathOnBlot);
        summary.removed += 1;
        summary.changedPaths.push(pathOnBlot);
        await updatePath(pathOnBlot);
        for (const descendant of descendants) await updatePath(descendant);
      } catch (e) {
        publish("Failed to remove", path_display, e.message);
        recordFailure(summary, pathOnBlot, e);
      }
    }
  }

  // Add every new remote file in this directory to the total before
  // processing any of them, so progress reflects the real amount of work
  // discovered instead of total growing in lockstep with current.
  const newFileCount = remoteContents.filter((remoteItem) => {
    const pathOnBlot = join(dir, remoteItem.name);
    return (
      !remoteItem.is_directory &&
      !isDotfileOrDotfolder(pathOnBlot) &&
      !localContents.find((localItem) => localItem.name === remoteItem.name)
    );
  }).length;
  progress.discover(newFileCount);

  for (const remoteItem of remoteContents) {
    const localCounterpart = localContents.find(
      (localItem) => localItem.name === remoteItem.name
    );

    const { path_display, name } = remoteItem;
    const pathOnDropbox = path_display;
    const pathOnBlot = join(dir, name);

    if (isDotfileOrDotfolder(pathOnBlot)) continue;

    if (remoteItem.is_directory) {
      let mkdirFailed = false;

      if (localCounterpart && !localCounterpart.is_directory) {
        progress.publish("Removing", pathOnBlot);
        await storage.remove(blogID, pathOnBlot);
        summary.removed += 1;
        summary.changedPaths.push(pathOnBlot);
        await updatePath(pathOnBlot);
        publish("Creating directory", pathOnBlot);
        try {
          await storage.mkdir(blogID, pathOnBlot);
          summary.createdDirs += 1;
          summary.changedPaths.push(pathOnBlot);
        } catch (e) {
          if (e.code !== "ENAMETOOLONG") throw e;
          summary.skipped += 1;
          mkdirFailed = true;
        }
      } else if (!localCounterpart) {
        publish("Creating directory", pathOnBlot);
        try {
          await storage.mkdir(blogID, pathOnBlot);
          summary.createdDirs += 1;
          summary.changedPaths.push(pathOnBlot);
          await updatePath(pathOnBlot);
        } catch (e) {
          if (e.code !== "ENAMETOOLONG") throw e;
          summary.skipped += 1;
          mkdirFailed = true;
        }
      }

      // Can't walk a directory that was never created.
      if (mkdirFailed) continue;

      await walk(
        blogID,
        client,
        publish,
        updatePath,
        dropboxRoot,
        join(dir, name),
        summary,
        progress
      );
    } else {
      if (hasUnsupportedExtension(pathOnDropbox)) {
        // A missing localCounterpart was already added to total by the
        // discover() pass above; only a type mismatch (local dir where a
        // file is expected) is new work discovered here.
        progress.publish(
          "Skipping unsupported file",
          pathOnBlot,
          Boolean(localCounterpart && localCounterpart.is_directory)
        );
        summary.skipped += 1;
        try {
          await storage.writePlaceholder(blogID, pathOnBlot, {
            code: "SYNC_UNSUPPORTED",
            kind: extname(pathOnDropbox).toLowerCase(),
          });
          await updatePath(pathOnBlot);
        } catch (err) {
          publish("Failed to create placeholder", pathOnBlot, err.message);
        }
        continue;
      }

      if (
        typeof remoteItem.size === "number" &&
        remoteItem.size > MAX_FILE_SIZE
      ) {
        progress.publish(
          "Skipping oversized file",
          `${pathOnBlot} (${remoteItem.size} bytes > ${MAX_FILE_SIZE} byte limit)`,
          Boolean(localCounterpart && localCounterpart.is_directory)
        );
        summary.skipped += 1;
        // A file we uploaded ourselves (upload sessions allow >100MB) must
        // not be replaced with an empty placeholder.
        if (
          localCounterpart &&
          !localCounterpart.is_directory &&
          remoteItem.content_hash &&
          localCounterpart.content_hash === remoteItem.content_hash
        ) {
          continue;
        }
        try {
          await storage.writePlaceholder(blogID, pathOnBlot, {
            code: "SYNC_TOO_LARGE",
            size: remoteItem.size,
            limit: MAX_FILE_SIZE,
          });
          await updatePath(pathOnBlot);
        } catch (err) {
          publish("Failed to create placeholder", pathOnBlot, err.message);
        }
        continue;
      }

      const identicalLocally =
        localCounterpart &&
        localCounterpart.content_hash === remoteItem.content_hash;

      if (localCounterpart && !identicalLocally) {
        progress.publish(
          "Downloading",
          pathOnBlot,
          localCounterpart.is_directory
        );
        try {
          await download(client, pathOnDropbox, blogID, pathOnBlot);
          summary.downloaded += 1;
          await updatePath(pathOnBlot);
          if (modifiedSince(remoteItem, summary.startedAt)) {
            summary.modifiedDuringWalk += 1;
            summary.modifiedPaths.push(pathOnBlot);
          } else summary.changedPaths.push(pathOnBlot);
        } catch (e) {
          // A file can end up with a destination path longer than the
          // filesystem allows – seen in production when a Dropbox account
          // got stuck wrapping the same file in nested "(Conflict met
          // exemplaar van ...)" copies. That download can never succeed.
          // countChanges() (clients/util/countChanges.js) only looks at downloaded/removed/
          // createdDirs, so this was never counted as an unsynced change
          // either way; recording it as "skipped" here is just for
          // visibility in logs/summaries, not to affect the hourly email.
          if (e.code === "ENAMETOOLONG") summary.skipped += 1;
          else recordFailure(summary, pathOnBlot, e);
          // Revoked access fails every remaining file: fail the resync.
          if (classify(e, SOURCES.APPLY).persist) throw e;
          continue;
        }
      } else if (!localCounterpart) {
        // Already added to total by the discover() pass above.
        progress.publish("Downloading", pathOnBlot, false);
        try {
          await download(client, pathOnDropbox, blogID, pathOnBlot);
          summary.downloaded += 1;
          await updatePath(pathOnBlot);
          if (modifiedSince(remoteItem, summary.startedAt)) {
            summary.modifiedDuringWalk += 1;
            summary.modifiedPaths.push(pathOnBlot);
          } else summary.changedPaths.push(pathOnBlot);
        } catch (e) {
          if (e.code === "ENAMETOOLONG") summary.skipped += 1;
          else recordFailure(summary, pathOnBlot, e);
          // Revoked access fails every remaining file: fail the resync.
          if (classify(e, SOURCES.APPLY).persist) throw e;
          continue;
        }
      } else {
        progress.publishThrottled("Checking", pathOnBlot);
      }
    }
  }
};

// Lowercased paths, relative to the blog folder, that Dropbox reports as
// changed since cursor. Removals and new directories have no timestamp for
// modifiedSince to check, so this is how a file deleted in Dropbox mid-walk
// is told apart from one a sync failed to remove. Returns null if Dropbox
// can't be asked, so nothing is excused.
const changedSinceCursor = async (client, cursor, dropboxRoot) => {
  const root = dropboxRoot === "/" ? "" : dropboxRoot.toLowerCase();
  const changed = [];

  try {
    let has_more;
    do {
      const { result } = await client.filesListFolderContinue({ cursor });
      has_more = result.has_more;
      cursor = result.cursor;
      for (const { path_lower } of result.entries) {
        if (!path_lower) continue;
        if (!root) changed.push(path_lower);
        else if (path_lower.startsWith(root + "/"))
          changed.push(path_lower.slice(root.length));
      }
    } while (has_more);
  } catch (err) {
    return null;
  }

  return changed;
};

// Deleting or adding a folder in Dropbox may be reported as just the folder
// or as the files inside it, so match ancestors and descendants too.
const overlapsAny = (path, changed) => {
  path = path.toLowerCase();
  return changed.some(
    (other) =>
      other === path ||
      path.startsWith(other + "/") ||
      other.startsWith(path + "/")
  );
};

// How many files of a removed folder to ask list_revisions about, and how many
// such calls one walk makes at most. A folder is dated by any one file inside
// it, and a walk that removed more than a handful of separate things has
// missed more than a webhook that was still in flight.
const MAX_REMOVED_SAMPLES = 3;
const MAX_REVISION_LOOKUPS = 20;

// The first few files (not folders) among the blog paths of a removed folder's
// descendants, as returned by localDescendants. Call it before the removal.
const sampleFiles = async (blogID, descendants) => {
  const files = [];
  for (const path of descendants) {
    if (files.length >= MAX_REMOVED_SAMPLES) break;
    try {
      if (!(await storage.stat(blogID, path)).isDirectory) files.push(path);
    } catch (err) {}
  }
  return files;
};

// True if Dropbox says one of these files on Blot was deleted during the walk
// or shortly before it. list_revisions is the only call that timestamps a
// deletion, and costs a request per file, so it is only made for changes the
// cursor check couldn't excuse. Any failure (the file never existed in
// Dropbox, rate limiting, no such route) means "unknown", never an error: the
// change is counted, as it was before this check existed. The error isn't
// persisted onto the blog either - it isn't a sync step that failed.
const deletedRecently = async (client, dropboxRoot, files, startedAt) => {
  for (const file of files) {
    try {
      const { result } = await client.filesListRevisions({
        path: join(dropboxRoot, file),
        mode: "path",
        limit: 1,
      });
      if (deletedSince(result, startedAt)) return true;
    } catch (err) {}
  }
  return false;
};

// Sets summary.changedDuringWalk to the number of summary.changedPaths that
// Dropbox shows were changed during the walk, or just before it, by:
// - the cursor: Dropbox reports the path (or something under or over it) as
//   changed since the pre-walk cursor;
// - a removal's deletion time (see deletedRecently), for a removed file, or a
//   removed folder via the files that were in it;
// - a created folder with a recently modified file downloaded into it.
// A change that none of these excuses is counted by countChanges.
const excuseRecentChanges = async (client, changed, dropboxRoot, summary) => {
  let lookups = 0;

  for (const path of summary.changedPaths) {
    if (changed && overlapsAny(path, changed)) {
      summary.changedDuringWalk += 1;
      continue;
    }

    const lower = path.toLowerCase();
    if (
      summary.modifiedPaths.some((modified) =>
        modified.toLowerCase().startsWith(lower + "/")
      )
    ) {
      summary.changedDuringWalk += 1;
      continue;
    }

    const files = summary.removedFiles[path] || [];
    if (!files.length || lookups + files.length > MAX_REVISION_LOOKUPS)
      continue;
    lookups += files.length;
    if (await deletedRecently(client, dropboxRoot, files, summary.startedAt))
      summary.changedDuringWalk += 1;
  }
};

// A file's hash is undefined if it can't be read, which never matches Dropbox's.
// Hashing can mean reading the whole file, so when Dropbox's size for the file
// is known it is compared first, from the index: files of different sizes
// can't have the same bytes.
const contentHash = async (blogID, path, size) => {
  try {
    if (typeof size === "number") {
      const stat = await storage.stat(blogID, path);
      if (stat.isDirectory || stat.size !== size) return undefined;
    }
    return (await storage.stat(blogID, path, { hash: true })).hash;
  } catch (e) {
    return undefined;
  }
};

// remoteContentsPromise is the same folder's listing in Dropbox (null if it
// is gone), for the sizes
const localReaddir = async (blogID, dir, remoteContentsPromise) => {
  const [contents, remoteContents] = await Promise.all([
    storage.listNames(blogID, dir),
    remoteContentsPromise,
  ]);

  return mapLimit(contents, HASH_CONCURRENCY, async ({ name, isDirectory }) => {
    const path_display = join(dir, name);
    const remoteItem = (remoteContents || []).find(
      (item) => item.name === name
    );

    return {
      name,
      path_display,
      is_directory: isDirectory,
      content_hash: isDirectory
        ? undefined
        : await contentHash(
            blogID,
            path_display,
            remoteItem && !remoteItem.is_directory ? remoteItem.size : undefined
          ),
    };
  });
};

// list_folder's 409 for a path that is no longer a folder in Dropbox
const vanishedFolder = (err) =>
  err &&
  err.status === 409 &&
  /^path\/(not_found|not_folder)\b/.test(dropboxTag(err));

const remoteReaddir = async (client, dir) => {
  let items = [];
  let cursor;
  let has_more;

  //path: Specify the root folder as an empty string rather than as "/".'
  if (dir === "/") dir = "";

  do {
    const { result } = await retryRequest(
      () =>
        cursor
          ? client.filesListFolderContinue({ cursor })
          : client.filesListFolder({ path: dir }),
      "remoteReaddir"
    );
    has_more = result.has_more;
    cursor = result.cursor;
    items = items.concat(
      result.entries.map((i) => {
        i.is_directory = i[".tag"] === "folder";
        return i;
      })
    );
  } while (has_more);

  return items;
};

module.exports = resetToBlot;
