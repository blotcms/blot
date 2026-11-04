const folder = require("storage/folder");
const remoteUpload = require("./sync/util/remoteUpload");
const database = require("./database");
const health = require("../health");
const { classify } = require("./error");
const shouldIgnoreFile = require("clients/util/shouldIgnoreFile");

module.exports = async (blogID, path, contents, callback) => {
  if (shouldIgnoreFile(path)) {
    return callback(new Error(`Cannot write ignored file: ${path}`));
  }

  try {
    await folder.write(blogID, path, contents);
  } catch (error) {
    console.error(`Blog: ${blogID} Error writing to ${path}:`, error);
    return callback(error);
  }

  try {
    // The shared iCloud folder was deleted: uploading would make the
    // macserver re-create an unshared folder. Keep the local write only.
    const account = await database.get(blogID);
    if (classify(account) === health.CODES.SOURCE_MISSING) return callback();

    await remoteUpload(blogID, path);
  } catch (error) {
    console.error(`Error uploading ${path} to remote:`, error);
    return callback(error);
  }

  callback();
};
