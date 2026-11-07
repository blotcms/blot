const createDriveClient = require("./serviceAccount/createDriveClient");
const clfdate = require("helper/clfdate");
const folder = require("storage/folder");
const database = require("./database");
const promiseOnly = require("helper/promiseOnly");

async function remove(blogID, path) {
  const prefix = () =>
    clfdate() + " Google Drive: Remove:" + blogID + ":" + path + ":";

  try {
    if (path[0] !== "/") path = "/" + path;

    const { serviceAccountId, folderId } = await database.blog.get(blogID);
    const drive = await createDriveClient(serviceAccountId);
    const { getByPath, remove } = database.folder(folderId, blogID);

    console.log(prefix(), "Removing from local folder");
    await folder.remove(blogID, path);

    console.log(prefix(), "Looking up fileId");
    const fileId = await getByPath(path);

    if (fileId) {
      console.log(prefix(), "Removing fileId from db");
      await remove(fileId);
      console.log(prefix(), "Removing fileId from API");
      await drive.files.delete({ fileId, supportsAllDrives: true });
    } else {
      console.log(prefix(), "WARNING No fileId found in db");
    }
  } catch (e) {
    console.log(prefix(), "Remove: Error", path, e);
    throw e;
  }
}

module.exports = promiseOnly(remove);
