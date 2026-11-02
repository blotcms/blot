const debug = require("debug")("blot:clients:local:remove");
const folder = require("storage/folder");

// Removes a file or folder from at a given path inside
// the blog's source folder. Needed to remove preview files
// and source files for templates.
module.exports = function remove(blogID, path, callback) {
  debug("Blog", blogID, "Removing", path);
  folder.remove(blogID, path).then(function () {
    callback(null);
  }, callback);
};
