const folder = require("storage/folder");
const database = require("./database");
const health = require("../health");
const { classify } = require("./error");
const remoteDelete = require("./sync/util/remoteDelete");

module.exports = async (blogID, path, callback) => {
  try {
    await folder.remove(blogID, path);

    // The shared iCloud folder was deleted: nothing to remove remotely, and
    // the macserver call could re-create an unshared folder.
    const account = await database.get(blogID);
    if (classify(account) === health.CODES.SOURCE_MISSING) return callback();

    await remoteDelete(blogID, path);
  } catch (error) {
    console.error(`Error removing ${path}:`, error);
    return callback(error);
  }

  callback();
};
