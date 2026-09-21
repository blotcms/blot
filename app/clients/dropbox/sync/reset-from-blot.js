const fs = require("fs-extra");
const { promisify } = require("util");
// const upload = promisify(require("clients/dropbox/util/upload"));
const join = require("path").join;
const clfdate = require("helper/clfdate");
const localPath = require("helper/localPath");
const hashFile = promisify((path, cb) => {
  require("helper/hashFile")(path, (err, result) => {
    cb(null, result);
  });
});
const upload = promisify(require("../util/upload"));
const { isDotfileOrDotfolder } = require("../util/constants");
const set = promisify(require("../database").set);
const persistError = promisify(require("../util/persistError"));
const { SOURCES, classify } = require("../util/classifyError");
const tagSource = require("../util/tagSource");
const createClient = promisify((blogID, cb) =>
  require("../util/createClient")(blogID, (err, ...results) => cb(err, results))
);

const ABORT_ERROR_MESSAGE = "Dropbox reset aborted";

function abortIfRequested(signal) {
  if (signal && signal.aborted) {
    const error = new Error(ABORT_ERROR_MESSAGE);
    error.name = "AbortError";
    throw error;
  }
}

function log() {
  const args = Array.prototype.slice.call(arguments);
  console.log(clfdate() + " Dropbox:", args.join(" "));
}

// Counts every local file and subdirectory (not the root) so folder
// creation and file transfers both advance the progress bar.
async function countLocalItems(localRoot, dir, signal) {
  abortIfRequested(signal);

  const contents = await fs.readdir(join(localRoot, dir));
  let total = 0;

  for (const name of contents) {
    abortIfRequested(signal);

    const path = join(dir, name);
    if (isDotfileOrDotfolder(path)) continue;

    const stat = await fs.stat(join(localRoot, path));
    total += 1;

    if (stat.isDirectory()) {
      total += await countLocalItems(localRoot, path, signal);
    }
  }

  return total;
}

function publishTransferStatus(progress, publish, path) {
  if (!progress) {
    publish("Transferring " + path);
    return;
  }

  progress.current += 1;
  publish(
    "(" + progress.current + "/" + progress.total + ") Transferring " + path
  );
}

async function resetFromBlot(blogID, publish, signal) {
  if (!publish)
    publish = function () {
      log.apply(null, arguments);
    };

  abortIfRequested(signal);

  // if (signal.aborted) return;
  // // this could become verify.fromBlot
  // await uploadAllFiles(account, folder, signal);

  // if (signal.aborted) return;
  // const account = await get(blogID);
  abortIfRequested(signal);

  let client, account;
  try {
    [client, account] = await createClient(blogID);
  } catch (err) {
    await persistError(blogID, err, SOURCES.AUTH);
    throw err;
  }

  try {
    await resetFromBlotWithClient(
      blogID,
      publish,
      signal,
      client,
      account
    );
  } catch (err) {
    if (!err || err.name !== "AbortError") {
      await persistError(blogID, err, SOURCES.APPLY);
    }
    throw err;
  }
}

// A failed upload is logged and skipped, unless retrying can never
// help (revoked access, full storage): that must fail the resync.
function rethrowIfDurable(err) {
  if (err && err.name === "AbortError") throw err;
  if (classify(err, SOURCES.APPLY).persist) throw err;
}

async function resetFromBlotWithClient(
  blogID,
  publish,
  signal,
  client,
  account
) {
  abortIfRequested(signal);

  let dropboxRoot = "/";
  const localRoot = localPath(blogID, "/");

  // Load the path to the blog folder root position in Dropbox
  if (account.folder_id) {
    abortIfRequested(signal);

    const { result } = await tagSource(
      SOURCES.DELTA,
      client.filesGetMetadata({ path: account.folder_id })
    );

    abortIfRequested(signal);
    const { path_display } = result;
    if (path_display) {
      dropboxRoot = path_display;
      abortIfRequested(signal);
      await set(blogID, { folder: path_display });
      abortIfRequested(signal);
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
  abortIfRequested(signal);

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

  abortIfRequested(signal);

  publish("Counting files...");
  const total = await countLocalItems(localRoot, "/", signal);
  const progress = total > 0 ? { current: 0, total: total } : null;
  log("counted " + total + " local files and folders to transfer");

  const walk = async (dir) => {
    abortIfRequested(signal);

    log("Checking", dir);

    const [remoteContents, localContents] = await Promise.all([
      remoteReaddir(client, join(dropboxRoot, dir), signal),
      localReaddir(blogID, localRoot, dir, signal),
    ]);

    abortIfRequested(signal);

    for (const { name } of remoteContents) {
      abortIfRequested(signal);

      const path = join(dir, name);
      if (!localContents.find((localItem) => localItem.name === name)) {
        log("Removing", path);
        try {
          abortIfRequested(signal);
          await client.filesDelete({ path: join(dropboxRoot, path) });
          abortIfRequested(signal);
        } catch (e) {
          rethrowIfDurable(e);
          log("Failed to remove", path, e.message);
        }
      }
    }

    for (const localItem of localContents) {
      abortIfRequested(signal);

      const path = join(dir, localItem.name);
      const remoteCounterpart = remoteContents.find(
        (remoteItem) => remoteItem.name === localItem.name
      );

      if (isDotfileOrDotfolder(path)) continue;

      if (localItem.is_directory) {
        abortIfRequested(signal);

        // Counted in the pre-walk — bump even if the folder already exists.
        publishTransferStatus(progress, publish, path);

        if (remoteCounterpart && !remoteCounterpart.is_directory) {
          log("Removing", path);
          abortIfRequested(signal);
          await client.filesDelete({ path: join(dropboxRoot, path) });
          abortIfRequested(signal);
          log("Creating directory", path);
          abortIfRequested(signal);
          await client.filesCreateFolder({
            path: join(dropboxRoot, path),
            autorename: false,
          });
          abortIfRequested(signal);
        } else if (!remoteCounterpart) {
          log("Creating directory", path);
          abortIfRequested(signal);
          await client.filesCreateFolder({
            path: join(dropboxRoot, path),
            autorename: false,
          });
          abortIfRequested(signal);
        }

        await walk(path);

        abortIfRequested(signal);
      } else {
        const identicalOnRemote =
          remoteCounterpart &&
          remoteCounterpart.content_hash === localItem.content_hash;

        // Counted in the pre-walk — bump even when the file is already identical.
        publishTransferStatus(progress, publish, path);

        if (remoteCounterpart && !identicalOnRemote) {
          try {
            abortIfRequested(signal);
            await upload(
              client,
              join(localRoot, localItem.path_display),
              join(dropboxRoot, path)
            );
            abortIfRequested(signal);
          } catch (e) {
            rethrowIfDurable(e);
            log("Failed to transfer", path);
          }
        } else if (!remoteCounterpart) {
          try {
            abortIfRequested(signal);
            await upload(
              client,
              join(localRoot, localItem.path_display),
              join(dropboxRoot, path)
            );
            abortIfRequested(signal);
          } catch (e) {
            rethrowIfDurable(e);
            log("Failed to transfer", path);
          }
        }
      }
    }
  };

  await walk("/");

  abortIfRequested(signal);

  // Because we fetch the cursor before making any changes,
  // we will recieve webhook notifications for the files we
  // write and then we'll resync them.

  abortIfRequested(signal);

  await set(blogID, {
    error_code: 0,
    cursor,
  });

  abortIfRequested(signal);

  log("Finished processing folder");

  // reset sync cursor
  // await set(blogID, {cursor: ''});

  // return account;
}

// async function uploadAllFiles(account, folder, signal, dir = "/") {
//   if (signal.aborted) return;
//
//   const items = await fs.readdir(localPath(account.blog.id, dir));
//
//   for (const item of items) {
//     if (signal.aborted) return;
//     const stat = await fs.stat(localPath(account.blog.id, join(dir, item)));
//     if (stat.isDirectory()) {
//       await uploadAllFiles(account, folder, signal, join(dir, item));
//     } else {
//       folder.status("Transferring " + join(dir, item));
//       const source = localPath(account.blog.id, join(dir, item));
//       const destination = join(account.folder, dir, item);
//
//       try {
//         await upload(account.client, source, destination);
//       } catch (err) {
//         const { status, error } = err;
//         if (
//           status === 409 &&
//           error.error_summary.startsWith("path/disallowed_name")
//         ) {
//           continue;
//         } else {
//           console.log("here,", status, error);
//           throw err;
//         }
//       }
//     }
//   }
// }

const localReaddir = async (blogID, localRoot, dir, signal) => {
  abortIfRequested(signal);

  const contents = await fs.readdir(join(localRoot, dir));

  abortIfRequested(signal);

  return Promise.all(
    contents.map(async (name) => {
      abortIfRequested(signal);

      const pathOnDisk = join(localRoot, dir, name);
      const [content_hash, stat] = await Promise.all([
        hashFile(pathOnDisk),
        fs.stat(pathOnDisk),
      ]);

      abortIfRequested(signal);

      return {
        name,
        path_display: join(dir, name),
        is_directory: stat.isDirectory(),
        content_hash,
      };
    })
  );
};

const remoteReaddir = async (client, dir, signal) => {
  abortIfRequested(signal);

  let items = [];
  let cursor;
  let has_more;

  //path: Specify the root folder as an empty string rather than as "/".'
  if (dir === "/") dir = "";

  do {
    abortIfRequested(signal);

    const { result } = cursor
      ? await client.filesListFolderContinue({ cursor })
      : await client.filesListFolder({ path: dir });

    abortIfRequested(signal);

    has_more = result.has_more;
    cursor = result.cursor;
    items = items.concat(
      result.entries.map((i) => {
        i.is_directory = i[".tag"] === "folder";
        return i;
      })
    );
  } while (has_more);

  abortIfRequested(signal);

  return items;
};

module.exports = resetFromBlot;
