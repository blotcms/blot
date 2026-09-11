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
} = require("../util/constants");
const shouldIgnoreFile = require("clients/util/shouldIgnoreFile");
const {
  countLocalFiles,
  createProgress,
} = require("clients/util/resyncProgress");

const set = promisify(require("../database").set);
const createClient = promisify((blogID, cb) =>
  require("../util/createClient")(blogID, (err, ...results) => cb(err, results))
);

// const upload = promisify(require("clients/dropbox/util/upload"));
// const get = promisify(require("../database").get);

async function resetToBlot(blogID, publish) {
  if (!publish)
    publish = (...args) => {
      console.log(clfdate() + " Dropbox:", args.join(" "));
    };

  publish("Syncing folder from Dropbox to Blot");

  // if (signal.aborted) return;
  // // this could become verify.fromBlot
  // await uploadAllFiles(account, folder, signal);

  // if (signal.aborted) return;
  // const account = await get(blogID);
  const [client, account] = await createClient(blogID);

  let dropboxRoot = "/";

  // Load the path to the blog folder root position in Dropbox
  if (account.folder_id) {
    const { result } = await client.filesGetMetadata({
      path: account.folder_id,
    });
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
  } = await client.filesListFolderGetLatestCursor({
    path: account.folder_id || "",
    include_deleted: true,
    recursive: true,
  });

  // This means that future syncs will be fast
  await set(blogID, { cursor });

  const summary = {
    downloaded: 0,
    removed: 0,
    createdDirs: 0,
    skipped: 0,
  };

  const localRoot = localPath(blogID, "/");
  const progress = createProgress(await countLocalFiles(localRoot), publish);

  await walk(blogID, client, publish, dropboxRoot, "/", summary, progress);

  await set(blogID, {
    error_code: 0,
  });

  progress.finish("Finished processing folder");

  return summary;
}

const walk = async (
  blogID,
  client,
  publish,
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
      if (localCounterpart && !localCounterpart.is_directory) {
        progress.publish("Removing", pathOnBlot);
        await fs.remove(pathOnDisk);
        summary.removed += 1;
        publish("Creating directory", pathOnDisk);
        await fs.mkdir(pathOnDisk);
        summary.createdDirs += 1;
      } else if (!localCounterpart) {
        publish("Creating directory", pathOnBlot);
        await fs.mkdir(pathOnDisk);
        summary.createdDirs += 1;
      }

      await walk(
        blogID,
        client,
        publish,
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
        } catch (e) {
          continue;
        }
      } else if (!localCounterpart) {
        // Already added to total by the discover() pass above.
        progress.publish("Downloading", pathOnBlot, false);
        try {
          await download(client, pathOnDropbox, pathOnDisk);
          summary.downloaded += 1;
        } catch (e) {
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

  return Promise.all(
    contents.map(async (name) => {
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
    })
  );
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
