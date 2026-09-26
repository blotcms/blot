const titleToFolder = require("clients/dropbox/util/titleToFolder");
const promisify = require("util").promisify;

const sync = require("sync");
const database = require("clients/dropbox/database");
const { transferIncomplete } = require("clients/dropbox/util/constants");

const listBlogs = promisify(database.listBlogs);
const get = promisify(database.get);
const set = promisify(database.set);

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

  const reused = await tryReuseIncompleteTransferFolder(account);

  if (reused) {
    account.folder = reused.folder;
    account.folder_id = reused.folder_id;
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

// If this blog is retrying a previously-interrupted initial transfer (see
// transferIncomplete() in util/constants.js) to the same Dropbox account
// under the same permission mode, reuse the folder that transfer was already
// using instead of creating a new one. Without this, every "Retry transfer"
// click would call mkdir(..., autorename: true) below, which Dropbox
// auto-renames to something like "My Blog (1)" since the original folder
// still exists (with whatever files did make it across) - abandoning that
// partial upload and doubling the pre-flight quota check's space
// requirement, since it would then need room for a second, near-complete
// copy of the folder on top of the first.
//
// Returns null (falling through to the normal folder-creation logic) for the
// app-folder-root case (folder_id === "" and not full_access): createFolder
// already leaves folder/folder_id as "" without ever calling mkdir when
// shouldCreateFolder is false, so there's nothing to recreate or abandon
// there, and no reuse logic is needed.
async function tryReuseIncompleteTransferFolder(account) {
  const { client, full_access, account_id, blog } = account;

  // Not wrapped in try/catch: a failure to read our own database here is a
  // transient infrastructure problem (e.g. Redis blip), not a confirmed "no
  // existing account" - swallowing it and falling through to mkdir would
  // risk the same abandoned-partial-folder problem this function exists to
  // prevent. Let it propagate and fail this setup attempt instead.
  const existing = await get(blog.id);

  if (!existing) return null;
  if (!transferIncomplete(existing)) return null;
  if (existing.account_id !== account_id) return null;
  if (existing.full_access !== full_access) return null;
  if (!existing.folder_id) return null;

  try {
    const { result } = await client.filesGetMetadata({
      path: existing.folder_id,
    });

    if (result[".tag"] !== "folder") return null;

    return { folder: result.path_display, folder_id: existing.folder_id };
  } catch (e) {
    // Only a confirmed "the folder is gone" (Dropbox's 409
    // path/not_found) should fall through to creating a brand new folder
    // and abandoning the partial transfer - that's a real, permanent state
    // change we need to react to. Anything else (a timeout, a rate limit, an
    // outage) is transient: rethrowing makes this setup attempt fail
    // (surfaced to the user as an error, same as any other setup failure)
    // instead of quietly abandoning a folder that's actually still there and
    // still has the partially-transferred files in it.
    if (isNotFoundError(e)) return null;
    throw e;
  }
}

function isNotFoundError(err) {
  if (!err || err.status !== 409) return false;
  const summary = err.error && err.error.error_summary;
  return typeof summary === "string" && summary.startsWith("path/not_found");
}

async function checkAppFolder(account) {
  let blogToMove = null;
  let blogsInAppFolder = null;

  const blogsWithThisDropboxAccount = await listBlogs(account.account_id);

  // If the Dropbox account for this other blog does not
  // have full folder permission and its folder is an empty
  // string (meaning it is the root of the app folder) then
  // there is an existing blog using the entire app folder.
  for (const blog of blogsWithThisDropboxAccount) {
    // Ignore the blog we're setting up
    if (blog.id === account.blog.id) continue;
    const { folder, full_access } = await get(blog.id);
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

function moveExistingFiles(client, otherBlog) {
  return new Promise((resolve, reject) => {
    // Get a lock on the blog
    // we should add a way to retry this sync attempt
    sync(otherBlog.id, async function (err, folder, done) {
      if (err) return reject(err);

      try {
        const { folder, folder_id } = await mkdir(client, otherBlog.title);

        let {
          result: { entries },
        } = await client.filesListFolder({
          path: "",
          include_deleted: false,
          recursive: false,
        });

        entries = entries
          .filter((entry) => entry.path_display !== folder)
          .map(function (entry) {
            return {
              from_path: entry.path_display,
              to_path: folder + entry.path_display,
            };
          });

        if (entries.length === 0) {
          await set(otherBlog.id, {
            folder,
            folder_id,
            cursor: "",
          });
          return done(null, resolve);
        }

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

        await set(otherBlog.id, {
          folder,
          folder_id,
          cursor: "",
        });
      } catch (err) {
        return done(err, reject);
      }

      done(null, resolve);
    });
  });
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
