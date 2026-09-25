const titleToFolder = require("clients/dropbox/util/titleToFolder");
const promisify = require("util").promisify;

const sync = require("sync");
const database = require("clients/dropbox/database");

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
