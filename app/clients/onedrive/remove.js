var fs = require("fs-extra");
var localPath = require("helper/localPath");
var debug = require("debug")("blot:clients:onedrive:remove");
var database = require("./database");
var graph = require("./util/graph");
var { persistError } = require("./util/persistError");
var { SOURCES } = require("./util/classifyError");
var { promisify } = require("util");

var get = promisify(database.get);

// Removes the file from the blog folder and from OneDrive. Like write,
// only removes locally until the OneDrive folder exists.
module.exports = function remove(blogID, path, callback) {
  debug("Blog:", blogID, "Removing", path);

  (async function () {
    await fs.remove(localPath(blogID, path));

    var account = await get(blogID);

    if (!account || !account.folder_id) return;

    try {
      await graph.deleteItem(blogID, account.folder_id, path);
    } catch (err) {
      await persistError(blogID, err, SOURCES.APPLY);
      throw err;
    }
  })().then(function () {
    debug("Blog:", blogID, "Removed", path);
    callback(null);
  }, callback);
};
