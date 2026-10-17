var fs = require("fs-extra");
var localPath = require("helper/localPath");
var debug = require("debug")("blot:clients:github:write");
var shouldIgnoreFile = require("clients/util/shouldIgnoreFile");

// Skeleton implementation: writes the file to disk only. Once a
// repository is connected, this needs to also commit the change via the
// GitHub Contents API (falling back to the Git Database API for files
// over 1MB) and suppress the resulting push webhook. See PLAN.md,
// "write, remove, disconnect".
module.exports = function write(blogID, path, contents, callback) {
  if (shouldIgnoreFile(path)) {
    return callback(new Error("Cannot write ignored file: " + path));
  }

  debug("Blog:", blogID, "Writing", path);

  fs.outputFile(localPath(blogID, path), contents, function (err) {
    if (err) return callback(err);
    debug("Blog:", blogID, "Wrote", path);
    callback(null);
  });
};
