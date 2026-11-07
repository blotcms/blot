const folder = require("storage/folder");
const database = require("./database");
const health = require("../health");
const { classify } = require("./error");
const remoteDelete = require("./sync/util/remoteDelete");

async function remove(blogID, path) {
  try {
    await folder.remove(blogID, path);

    // The shared iCloud folder was deleted: nothing to remove remotely, and
    // the macserver call could re-create an unshared folder.
    const account = await database.get(blogID);
    if (classify(account) === health.CODES.SOURCE_MISSING) return;

    await remoteDelete(blogID, path);
  } catch (error) {
    console.error(`Error removing ${path}:`, error);
    throw error;
  }
}

module.exports = remove;
