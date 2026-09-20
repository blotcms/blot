var fs = require("fs-extra");
var localPath = require("helper/localPath");
var debug = require("debug")("blot:clients:onedrive:remove");

// Skeleton implementation: removes the file on disk only. Once a folder
// is connected, this needs to also delete the item in OneDrive via
// Microsoft Graph. See PLAN.md, "write, remove, disconnect".
module.exports = function remove(blogID, path, callback) {
  debug("Blog:", blogID, "Removing", path);

  fs.remove(localPath(blogID, path), function (err) {
    if (err) return callback(err);
    debug("Blog:", blogID, "Removed", path);
    callback(null);
  });
};
