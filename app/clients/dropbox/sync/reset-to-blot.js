const fs = require("fs-extra");
const { promisify } = require("util");
const { join } = require("path");
const clfdate = require("helper/clfdate");
const localPath = require("helper/localPath");
const hashFile = promisify((path, cb) => {
  require("helper/hashFile")(path, (err, result) => {
    cb(null, result);
  });
});
const download = promisify(require("../util/download"));
const {
  MAX_FILE_SIZE,
  hasUnsupportedExtension,
  isDotfileOrDotfolder,
  transferIncomplete,
} = require("../util/constants");
const modifiedSince = require("./modified-since");
const shouldIgnoreFile = require("clients/util/shouldIgnoreFile");
const {
  countLocalFiles,
  createProgress,
} = require("clients/util/resyncProgress");

const set = promisify(require("../database").set);
const persistError = promisify(require("../util/persistError"));
const {
  SOURCES,
  classify,
  keepsErrorAfterDownload,
} = require("../util/classifyError");
const tagSource = require("../util/tagSource");
const createClient = promisify((blogID, cb) =>
  require("../util/createClient")(blogID, (err, ...results) => cb(err, results))
);

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

// const upload = promisify(require("clients/dropbox/util/upload"));
// const get = promisify(require("../database").get);

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
      client.filesGetMetadata({ path: account.folder_id })
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
    client.filesListFolderGetLatestCursor({
      path: account.folder_id || "",
      include_deleted: true,
      recursive: true,
    })
  );

  // The cursor is fetched before the walk, so edits made during it are still
  // seen by the next sync, but only saved once the walk succeeds. If the walk
  // throws, the old cursor stays and the next webhook can still see those files.

  const summary = {
    downloaded: 0,
    removed: 0,
    createdDirs: 0,
    skipped: 0,
    // Subset of downloaded: files Dropbox modified after we started.
    modifiedDuringWalk: 0,
    startedAt,
  };

  const localRoot = localPath(blogID, "/");
  const progress = createProgress(await countLocalFiles(localRoot), publish);

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
  const localRoot = localPath(blogID, "/");
  publish("Checking", dir);
  const [remoteContents, localContents] = await Promise.all([
    remoteReaddir(client, join(dropboxRoot, dir)),
    localReaddir(blogID, localRoot, dir),
  ]);

  for (const { name, path_display, is_directory } of localContents) {
    const pathOnBlot = join(dir, name);
    const pathOnDisk = join(localRoot, dir, name);
    // A directory removed in one fs.remove call still accounts for every
    // file total counted inside it, so current must advance by that many.
    const removedCount = is_directory
      ? await countLocalFiles(pathOnDisk)
      : 1;

    if (shouldIgnoreFile(pathOnBlot)) {
      progress.publish("Removing ignored", pathOnBlot, false, removedCount);
      try {
        await fs.remove(pathOnDisk);
        summary.removed += 1;
        await updatePath(pathOnBlot);
      } catch (e) {
        publish("Failed to remove ignored", path_display, e.message);
      }
      continue;
    }

    const remoteCounterpart = remoteContents.find(
      (remoteItem) => remoteItem.name === name
    );

    if (!remoteCounterpart) {
      progress.publish("Removing", pathOnBlot, false, removedCount);
      try {
        await fs.remove(pathOnDisk);
        summary.removed += 1;
        await updatePath(pathOnBlot);
      } catch (e) {
        publish("Failed to remove", path_display, e.message);
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
    const pathOnDisk = join(localRoot, dir, name);

    if (isDotfileOrDotfolder(pathOnBlot)) continue;

    if (remoteItem.is_directory) {
      let mkdirFailed = false;

      if (localCounterpart && !localCounterpart.is_directory) {
        progress.publish("Removing", pathOnBlot);
        await fs.remove(pathOnDisk);
        summary.removed += 1;
        await updatePath(pathOnBlot);
        publish("Creating directory", pathOnDisk);
        try {
          await fs.mkdir(pathOnDisk);
          summary.createdDirs += 1;
        } catch (e) {
          if (e.code !== "ENAMETOOLONG") throw e;
          summary.skipped += 1;
          mkdirFailed = true;
        }
      } else if (!localCounterpart) {
        publish("Creating directory", pathOnBlot);
        try {
          await fs.mkdir(pathOnDisk);
          summary.createdDirs += 1;
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
          await fs.outputFile(pathOnDisk, "");
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
        try {
          await fs.outputFile(pathOnDisk, "");
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
          await download(client, pathOnDropbox, pathOnDisk);
          summary.downloaded += 1;
          await updatePath(pathOnBlot);
          if (modifiedSince(remoteItem, summary.startedAt))
            summary.modifiedDuringWalk += 1;
        } catch (e) {
          // A file can end up with a destination path longer than the
          // filesystem allows – seen in production when a Dropbox account
          // got stuck wrapping the same file in nested "(Conflict met
          // exemplaar van ...)" copies. That download can never succeed.
          // countChanges() (sync/count-changes.js) only looks at downloaded/removed/
          // createdDirs, so this was never counted as an unsynced change
          // either way; recording it as "skipped" here is just for
          // visibility in logs/summaries, not to affect the hourly email.
          if (e.code === "ENAMETOOLONG") summary.skipped += 1;
          // Revoked access fails every remaining file: fail the resync.
          if (classify(e, SOURCES.APPLY).persist) throw e;
          continue;
        }
      } else if (!localCounterpart) {
        // Already added to total by the discover() pass above.
        progress.publish("Downloading", pathOnBlot, false);
        try {
          await download(client, pathOnDropbox, pathOnDisk);
          summary.downloaded += 1;
          await updatePath(pathOnBlot);
          if (modifiedSince(remoteItem, summary.startedAt))
            summary.modifiedDuringWalk += 1;
        } catch (e) {
          if (e.code === "ENAMETOOLONG") summary.skipped += 1;
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

const localReaddir = async (blogID, localRoot, dir) => {
  const contents = await fs.readdir(join(localRoot, dir));

  return mapLimit(contents, HASH_CONCURRENCY, async (name) => {
    const pathOnDisk = join(localRoot, dir, name);
    const [content_hash, stat] = await Promise.all([
      hashFile(pathOnDisk),
      fs.stat(pathOnDisk),
    ]);

    return {
      name,
      path_display: join(dir, name),
      is_directory: stat.isDirectory(),
      content_hash,
    };
  });
};

const remoteReaddir = async (client, dir) => {
  let items = [];
  let cursor;
  let has_more;

  //path: Specify the root folder as an empty string rather than as "/".'
  if (dir === "/") dir = "";

  do {
    const { result } = cursor
      ? await client.filesListFolderContinue({ cursor })
      : await client.filesListFolder({ path: dir });
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
