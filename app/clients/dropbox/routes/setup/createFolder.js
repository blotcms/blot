const titleToFolder = require("clients/dropbox/util/titleToFolder");

const sync = require("sync");
const drain = require("helper/drain");
const database = require("clients/dropbox/database");
const { transferIncomplete } = require("clients/dropbox/util/constants");

// We sometimes need to move the files in the user's
// Dropbox / Apps / Blot directory into a subfolder
// if this blog is the second blog they're connecting
// to the same Dropbox account.

// Since this blog is connected to Dropbox with 'app folder'
// permissions and there are no other blogs in this app folder
// we do not need to do anything: the folder was created by
// dropbox when they granted Blot permission.

// We only need to move the other blog's files if it's not
// already using a sub folder of the App folder, which can
// occur when you:
// 1. connect two blogs to Dropbox with app folder perms
// 2. then remove one
// 3. then re-connect another
async function createFolder(account) {
  const { client, full_access } = account;

  const reused = await tryReuseFolder(account);

  if (reused) {
    account.folder = reused.folder;
    account.folder_id = reused.folder_id;
    // On a reconnect, and on a retry of a reconnect's transfer, setup
    // uploads only what the folder lacks, since it may hold the person's
    // own writing (see setup/index.js). A file on one side where the other
    // has a folder then fails the transfer with its path, and the person
    // resolves it by renaming in Dropbox: which copy to drop isn't ours to
    // pick silently. A retry of a plain first transfer runs the normal
    // reset, since that folder only ever held Blot's own partial upload.
    if (reused.reconnect) account.reused_folder = true;
    return account;
  }

  const { blogToMove, blogsInAppFolder } = await checkAppFolder(account);
  const shouldCreateFolder = full_access || blogToMove || blogsInAppFolder;

  if (blogToMove) await moveExistingFiles(client, blogToMove);

  const { folder, folder_id } = shouldCreateFolder
    ? await mkdir(client, account.blog.title)
    : { folder_id: "", folder: "" };

  account.folder = folder;
  account.folder_id = folder_id;

  return account;
}

// Reuses a folder this blog already had on the same Dropbox account, instead
// of calling mkdir(..., autorename: true) below, which Dropbox auto-renames
// to something like "My Blog (1)" because the old folder still exists:
// - a retry of an initial transfer that was cut short (transferIncomplete()
//   in util/constants.js), under the same permission mode, keeps the folder
//   that transfer was using, with the files that made it across;
// - a reconnect after a disconnect keeps the folder the blog used before
//   (database.getPrevious), wherever it is now, if the new permission mode
//   can reach it: app-folder ids only resolve inside the app folder.
// Only a folder recorded against this blog is reused, never one that merely
// has the right name, and never one that is, holds or sits inside another
// blog's folder on the account: either would publish someone else's files
// on this blog.
//
// Returns null (falling through to the normal folder-creation logic)
// otherwise, including the app-folder-root case (folder_id === ""), which
// createFolder already reuses without calling mkdir.
async function tryReuseFolder(account) {
  const { client, full_access, account_id, blog } = account;

  // Not wrapped in try/catch: a failure to read our own database here is a
  // transient infrastructure problem (e.g. Redis blip), not a confirmed "no
  // existing account" - swallowing it and falling through to mkdir would
  // abandon the folder this function exists to keep. Let it propagate and
  // fail this setup attempt instead.
  const existing = await database.get(blog.id);

  let candidate = null;
  let reconnect = false;

  if (!existing) {
    candidate = await database.getPrevious(blog.id);
    reconnect = true;
  } else if (
    transferIncomplete(existing) &&
    existing.full_access === full_access
  ) {
    candidate = existing;
    // A retry of a reconnect's transfer that failed
    reconnect = existing.reused_folder === true;
  }

  if (!candidate || !candidate.folder_id) return null;
  if (candidate.account_id !== account_id) return null;

  const path = await folderPath(client, candidate.folder_id);
  if (!path) return null;
  if (await overlapsAnotherBlog(account, candidate.folder_id, path.lower))
    return null;

  return {
    folder: path.display,
    folder_id: candidate.folder_id,
    reconnect,
  };
}

// The folder's current path as this client sees it, or null if it's gone.
// Only a confirmed "the folder is gone" (Dropbox's 409 path/not_found, which
// is also what an app-folder token gets for a folder outside the app folder)
// returns null. Anything else (a timeout, a rate limit, an outage) is
// transient: rethrowing fails this setup attempt instead of quietly
// abandoning a folder that's still there.
async function folderPath(client, folder_id) {
  try {
    const { result } = await client.filesGetMetadata({ path: folder_id });
    if (result[".tag"] !== "folder") return null;
    return {
      display: result.path_display,
      lower: result.path_lower || result.path_display.toLowerCase(),
    };
  } catch (e) {
    if (isNotFoundError(e)) return null;
    throw e;
  }
}

// True if another blog connected to this Dropbox account uses the folder, is
// having its files moved into it, or syncs a folder inside it or around it.
// An empty folder_id is the root of the app folder or of Dropbox, which
// holds everything.
async function overlapsAnotherBlog(account, folder_id, pathLower) {
  const blogs = await database.listBlogs(account.account_id);
  const overlaps = (a, b) => a === b || a.startsWith(b + "/");

  for (const other of blogs) {
    if (other.id === account.blog.id) continue;
    const otherAccount = await database.get(other.id);
    if (!otherAccount) continue;
    if (!otherAccount.folder_id) return true;
    if (otherAccount.folder_id === folder_id) return true;
    if (otherAccount.move_folder_id === folder_id) return true;

    const otherPath = await folderPath(account.client, otherAccount.folder_id);
    if (!otherPath) continue;
    if (overlaps(pathLower, otherPath.lower)) return true;
    if (overlaps(otherPath.lower, pathLower)) return true;
  }

  return false;
}

function isNotFoundError(err) {
  if (!err || err.status !== 409) return false;
  const summary = err.error && err.error.error_summary;
  return typeof summary === "string" && summary.startsWith("path/not_found");
}

async function checkAppFolder(account) {
  let blogToMove = null;
  let blogsInAppFolder = null;

  const blogsWithThisDropboxAccount = await database.listBlogs(
    account.account_id
  );

  // If the Dropbox account for this other blog does not
  // have full folder permission and its folder is an empty
  // string (meaning it is the root of the app folder) then
  // there is an existing blog using the entire app folder.
  for (const blog of blogsWithThisDropboxAccount) {
    // Ignore the blog we're setting up
    if (blog.id === account.blog.id) continue;
    const { folder, full_access } = await database.get(blog.id);
    // Another blog on this Dropbox account does not use
    // the app folder
    if (full_access === true) continue;

    // There are other blogs using app folder
    blogsInAppFolder = true;

    // Another blog on this Dropbox account uses the app
    // folder but is not inside a subdirectory
    if (folder === "" && account.full_access === false) blogToMove = blog;
  }

  return { blogToMove, blogsInAppFolder };
}

// Moves the other blog's files from the root of the app folder into a
// subfolder of their own, under that blog's folder lock. The subfolder is
// recorded on its account first (move_folder/move_folder_id), which pauses
// its syncs (transferIncomplete) until the move is done. A move a deploy or
// crash cut short is finished into the same subfolder by whatever runs this
// next: a retried setup, or the startup and hourly jobs (init.js).
//
// options.resume is for the startup and hourly jobs: they only finish a move
// that is still recorded, and leave the blog alone otherwise.
async function moveExistingFiles(client, otherBlog, options = {}) {
  // Webhooks can keep the blog's lock busy for longer than sync() waits for
  // it, so try again for about two minutes. Only a busy lock is retried, and
  // not while draining: the startup and hourly jobs finish a recorded move.
  const { retryMs = 5000, tries = 24 } = options;
  for (let attempt = 1; ; attempt++) {
    try {
      return await moveUnderLock(client, otherBlog, options);
    } catch (err) {
      const busy = err?.message === "Failed to acquire folder lock";
      if (!busy || attempt >= tries || drain.isDraining()) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
}

async function moveUnderLock(client, otherBlog, options) {
  await sync(otherBlog.id, async function () {
    const account = await database.get(otherBlog.id);
    if (!account) return;
    // Finished since the caller looked, by whatever held the lock
    if (!account.move_folder_id && (options.resume || account.folder)) return;

    const { folder, folder_id } = await moveTarget(client, otherBlog, account);

    let {
      result: { entries },
    } = await client.filesListFolder({
      path: "",
      include_deleted: false,
      recursive: false,
    });

    entries = entries
      .filter((entry) => entry.id !== folder_id)
      .map(function (entry) {
        return {
          from_path: entry.path_display,
          to_path: folder + entry.path_display,
        };
      });

    if (entries.length) await moveBatch(client, entries);

    await database.set(otherBlog.id, {
      folder,
      folder_id,
      cursor: "",
      move_folder: "",
      move_folder_id: "",
    });
  });
}

// The subfolder the other blog's files go to: the one a move cut short
// recorded, if it is still there, or a new one, recorded before anything
// moves
async function moveTarget(client, otherBlog, account) {
  if (account.move_folder_id) {
    try {
      const { result } = await client.filesGetMetadata({
        path: account.move_folder_id,
      });
      if (result[".tag"] === "folder")
        return {
          folder: result.path_display,
          folder_id: account.move_folder_id,
        };
    } catch (e) {
      // Gone, so start again with a new one. Anything else fails the move.
      if (!isNotFoundError(e)) throw e;
    }
  }

  const { folder, folder_id } = await mkdir(client, otherBlog.title);

  await database.set(otherBlog.id, {
    move_folder: folder,
    move_folder_id: folder_id,
  });

  return { folder, folder_id };
}

async function moveBatch(client, entries) {
  const {
    result: { async_job_id },
  } = await client.filesMoveBatch({
    entries,
    autorename: false,
  });

  let tag;

  do {
    const { result } = await client.filesMoveBatchCheck({ async_job_id });

    tag = result[".tag"];

    if (tag === "failed")
      throw new Error("Failed to move files, please try again.");

    if (tag !== "complete" && tag !== "in_progress")
      throw new Error("Unknown response " + JSON.stringify(result));
  } while (tag === "in_progress");
}

async function mkdir(client, title) {
  const path = "/" + titleToFolder(title);

  const {
    result: { id, path_display },
  } = await client.filesCreateFolder({ path, autorename: true });

  const folder = path_display;
  const folder_id = id;

  return { folder, folder_id };
}

module.exports = createFolder;
module.exports.moveExistingFiles = moveExistingFiles;
