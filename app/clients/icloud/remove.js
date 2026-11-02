const folder = require("storage/folder");
const remoteDelete = require("./sync/util/remoteDelete");

module.exports = async (blogID, path, callback) => {
  try {
    await folder.remove(blogID, path);
    await remoteDelete(blogID, path);
  } catch (error) {
    console.error(`Error removing ${path}:`, error);
    return callback(error);
  }

  callback();
};
