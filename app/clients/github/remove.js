var fs = require("fs-extra");
var localPath = require("helper/localPath");
var debug = require("debug")("blot:clients:github:remove");

// Skeleton implementation: removes the file on disk only. Once a
// repository is connected, this needs to also commit the deletion via
// the GitHub Contents API and suppress the resulting push webhook. See
// PLAN.md, "write, remove, disconnect".
module.exports = function remove(blogID, path, callback) {
  debug("Blog:", blogID, "Removing", path);

  fs.remove(localPath(blogID, path), function (err) {
    if (err) return callback(err);
    debug("Blog:", blogID, "Removed", path);
    callback(null);
  });
};
