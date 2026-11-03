const { promisify } = require("util");
const database = require("../database");
const graph = require("../util/graph");
const { persistError, clearError } = require("../util/persistError");
const { SOURCES } = require("../util/classifyError");

const get = promisify(database.get);
const set = promisify(database.set);

// Loads the blog's OneDrive account and confirms its folder still exists,
// which is how a deleted folder is detected (SOURCE_MISSING). Also picks up
// a rename, since we track the folder by ID. Clears any stored error, as
// reaching this point proves access and the folder are fine.
module.exports = async function verifyFolder(blogID) {
  const account = await get(blogID);

  if (!account) throw new Error("No OneDrive account for blog " + blogID);

  if (!account.folder_id) {
    throw new Error("OneDrive folder for blog " + blogID + " is not set up");
  }

  let item;

  try {
    item = await graph.getItem(blogID, account.folder_id);
  } catch (err) {
    await persistError(blogID, err, SOURCES.FOLDER);
    throw err;
  }

  // Graph can report a deleted item (e.g. moved to the recycle bin)
  if (item.deleted) {
    const err = new Error("OneDrive folder was deleted");
    err.status = 404;
    await persistError(blogID, err, SOURCES.FOLDER);
    throw err;
  }

  if (item.name !== account.folder) {
    await set(blogID, { folder: item.name });
  }

  await clearError(blogID);

  return account;
};
