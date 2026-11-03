var fs = require("fs-extra");
var localPath = require("helper/localPath");
var debug = require("debug")("blot:clients:onedrive:write");
var shouldIgnoreFile = require("clients/util/shouldIgnoreFile");
var database = require("./database");
var graph = require("./util/graph");
var { persistError } = require("./util/persistError");
var { SOURCES } = require("./util/classifyError");
var { promisify } = require("util");

var get = promisify(database.get);

// Writes the file to the blog folder and uploads it to OneDrive. Should
// only be called inside the function returned from Sync for the blog, since
// it modifies the blog folder. Before the OneDrive folder exists (during
// setup, which uploads the whole folder afterwards) it only writes locally.
module.exports = function write(blogID, path, contents, callback) {
  if (shouldIgnoreFile(path)) {
    return callback(new Error("Cannot write ignored file: " + path));
  }

  debug("Blog:", blogID, "Writing", path);

  (async function () {
    await fs.outputFile(localPath(blogID, path), contents);

    var account = await get(blogID);

    if (!account || !account.folder_id) return;

    try {
      await graph.upload(blogID, account.folder_id, path, localPath(blogID, path));
    } catch (err) {
      await persistError(blogID, err, SOURCES.APPLY);
      throw err;
    }
  })().then(function () {
    debug("Blog:", blogID, "Wrote", path);
    callback(null);
  }, callback);
};
