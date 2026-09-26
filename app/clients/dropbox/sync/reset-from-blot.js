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
const {
  isDotfileOrDotfolder,
  isInsufficientSpaceError,
  INSUFFICIENT_SPACE_ERROR_CODE,
} = require("../util/constants");
const set = promisify(require("../database").set);
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

// Sums the size on disk of every local file (not folders) so we can compare
// it against the free space in Dropbox before uploading anything. This is
// deliberately conservative: some of these files might already be identical
// on Dropbox and wouldn't actually need to be re-uploaded (see the
// identicalOnRemote check in walk() below), so this can overestimate the
// space actually required. Overestimating just means we might block a
// transfer that would technically have fit - far safer than the alternative
// of underestimating and running out of space mid-transfer, which is what
// caused the data loss this guards against.
async function sumLocalBytes(localRoot, dir, signal) {
  abortIfRequested(signal);

  const contents = await fs.readdir(join(localRoot, dir));
  let total = 0;

  for (const name of contents) {
    abortIfRequested(signal);

    const path = join(dir, name);
    if (isDotfileOrDotfolder(path)) continue;

    const stat = await fs.stat(join(localRoot, path));

    if (stat.isDirectory()) {
      total += await sumLocalBytes(localRoot, path, signal);
    } else {
      total += stat.size;
    }
  }

  return total;
}

// Returns the user's free space in bytes, or null if it can't be determined
// (an unrecognized allocation shape, or the request itself failing) so the
// caller can treat "unknown" as "don't block the transfer".
async function getFreeSpaceBytes(client) {
  let result;

  try {
    ({ result } = await client.usersGetSpaceUsage());
  } catch (e) {
    log("Failed to check Dropbox space usage, skipping pre-flight check", e.message);
    return null;
  }

  const { used, allocation } = result || {};
  if (typeof used !== "number" || !allocation) return null;

  if (allocation[".tag"] === "individual" && typeof allocation.allocated === "number") {
    return allocation.allocated - used;
  }

  if (allocation[".tag"] === "team") {
    // A team admin can cap how much of the shared pool each member may use,
    // but user_within_team_space_allocated is only a real ceiling when
    // user_within_team_space_limit_type is "stop_sync" - Dropbox's own docs
    // say that's the only one of the three where "Dropbox file sync will
    // stop after the limit is reached" (see MemberSpaceLimitType in the
    // SDK's type definitions). "off" (no limit) and "alert_only" (a
    // notification-only soft limit - sync keeps working past it) both mean
    // the real constraint is the shared team pool, same as when no per-user
    // allocation is set at all.
    const limitType =
      allocation.user_within_team_space_limit_type &&
      allocation.user_within_team_space_limit_type[".tag"];

    if (
      limitType === "stop_sync" &&
      typeof allocation.user_within_team_space_allocated === "number" &&
      allocation.user_within_team_space_allocated > 0
    ) {
      return allocation.user_within_team_space_allocated - used;
    }
    if (typeof allocation.allocated === "number") {
      return allocation.allocated - allocation.used;
    }
  }

  // allocation[".tag"] === "other", or a shape we don't recognize - don't
  // block setup over something we can't confidently evaluate.
  return null;
}

// Recursively sums the size of every file already present under `dir` in
// Dropbox. resetFromBlot makes the Dropbox folder mirror the local folder
// (see walk() below: it deletes anything on Dropbox with no local
// counterpart), so the actual net growth in Dropbox's usage from this
// transfer is (local bytes) minus (bytes already sitting in this folder on
// Dropbox), not the full local size - a repeat transfer after a partial
// failure would otherwise be blocked by the full local size even once the
// user has freed up exactly enough room for what's left to upload.
// remoteReaddir is defined further down this file (const, module scope) -
// safe to reference here since this only runs once the module has finished
// loading.
async function sumRemoteBytes(client, dir, signal) {
  abortIfRequested(signal);

  let items;
  try {
    items = await remoteReaddir(client, dir, signal);
  } catch (e) {
    // Best-effort, same as getFreeSpaceBytes above: if we can't list what's
    // already there, treat it as nothing rather than blocking setup.
    log("Failed to list existing Dropbox folder contents for quota check", e.message);
    return 0;
  }

  let total = 0;
  for (const item of items) {
    abortIfRequested(signal);
    if (item.is_directory) {
      total += await sumRemoteBytes(client, item.path_display, signal);
    } else if (typeof item.size === "number") {
      total += item.size;
    }
  }

  return total;
}

function insufficientSpaceError(message) {
  const error = new Error(message);
  error.code = "DROPBOX_INSUFFICIENT_SPACE";
  return error;
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

  const [client, account] = await createClient(blogID);

  abortIfRequested(signal);

  let dropboxRoot = "/";
  const localRoot = localPath(blogID, "/");

  // Load the path to the blog folder root position in Dropbox
  if (account.folder_id) {
    abortIfRequested(signal);

    const { result } = await client.filesGetMetadata({
      path: account.folder_id,
    });

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
  } = await client.filesListFolderGetLatestCursor({
    path: account.folder_id || "",
    include_deleted: true,
    recursive: true,
  });

  abortIfRequested(signal);

  publish("Counting files...");
  const total = await countLocalItems(localRoot, "/", signal);
  const progress = total > 0 ? { current: 0, total: total } : null;
  log("counted " + total + " local files and folders to transfer");

  abortIfRequested(signal);

  // Pre-flight quota check: work out roughly how much we're about to upload
  // and bail before touching Dropbox at all if there's clearly not enough
  // room. See the DATA LOSS note above resetToBlot's deletion logic in
  // sync/reset-to-blot.js - if we start uploading anyway and run out of
  // space partway through, resetToBlot later treats the files we never
  // managed to upload as "deleted on Dropbox" and removes them from Blot.
  publish("Checking Dropbox storage space...");
  const [localBytes, freeSpaceBytes, existingRemoteBytes] = await Promise.all([
    sumLocalBytes(localRoot, "/", signal),
    getFreeSpaceBytes(client),
    sumRemoteBytes(client, dropboxRoot, signal),
  ]);

  abortIfRequested(signal);

  // Net new bytes this transfer needs room for - see sumRemoteBytes' comment
  // for why it's local minus what's already there, not the full local size.
  const netBytesToUpload = Math.max(0, localBytes - existingRemoteBytes);

  if (typeof freeSpaceBytes === "number" && netBytesToUpload > freeSpaceBytes) {
    log(
      "Not enough free space in Dropbox to transfer this folder:",
      netBytesToUpload,
      "net bytes needed (",
      localBytes,
      "local -",
      existingRemoteBytes,
      "already on Dropbox ), ",
      freeSpaceBytes,
      "bytes free"
    );
    await set(blogID, { error_code: INSUFFICIENT_SPACE_ERROR_CODE });
    throw insufficientSpaceError(
      "Dropbox does not have enough free space to transfer this blog's folder"
    );
  }

  // Failed uploads that aren't due to running out of space (e.g. a
  // persistent network error even after retry.js's 6 attempts). We still
  // try to transfer everything else, but we must not report success at the
  // end if any of these happened - a "successful" reset-from-blot is what
  // tells later code (resetToBlot / hourly validation) it's safe to treat
  // Dropbox as the source of truth and delete local files with no Dropbox
  // counterpart.
  const failures = [];

  // Shared by both upload sites below. An insufficient-space error means
  // every subsequent upload will fail the same way, so we stop the whole
  // transfer immediately rather than continuing to grind through retries
  // (retry.js also stops retrying this specific error - see util/retry.js)
  // and persist the error state so resetToBlot/validation know not to treat
  // Dropbox as authoritative until this is resolved (see init.js).
  const handleUploadFailure = async (e, path) => {
    if (isInsufficientSpaceError(e) || e.code === "DROPBOX_INSUFFICIENT_SPACE") {
      log("Dropbox ran out of space while transferring", path);
      await set(blogID, { error_code: INSUFFICIENT_SPACE_ERROR_CODE });
      throw insufficientSpaceError(
        "Dropbox ran out of space while transferring this blog's folder"
      );
    }
    log("Failed to transfer", path);
    failures.push(path);
  };

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
            await handleUploadFailure(e, path);
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
            await handleUploadFailure(e, path);
          }
        }
      }
    }
  };

  await walk("/");

  abortIfRequested(signal);

  // Don't report success (and don't advance the cursor) if any file failed
  // to transfer. Reporting success here is what makes resetToBlot/hourly
  // validation trust Dropbox as the source of truth and delete local files
  // that were never actually uploaded - see the DATA LOSS note above.
  if (failures.length > 0) {
    const error = new Error(
      "Failed to transfer " +
        failures.length +
        " file(s) to Dropbox: " +
        failures.slice(0, 5).join(", ") +
        (failures.length > 5 ? ", ..." : "")
    );
    error.code = "DROPBOX_TRANSFER_INCOMPLETE";
    throw error;
  }

  // Because we fetch the cursor before making any changes,
  // we will recieve webhook notifications for the files we
  // write and then we'll resync them.

  abortIfRequested(signal);

  // Only this fully-successful path may clear transfer_pending - it's what
  // tells every other automatic sync path (see transferIncomplete() in
  // util/constants.js) that Dropbox now has everything Blot has and can
  // safely be trusted as the source of truth.
  await set(blogID, {
    error_code: 0,
    cursor,
    transfer_pending: false,
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
