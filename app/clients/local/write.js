const debug = require("debug")("blot:clients:local:write");
const folder = require("storage/folder");
const shouldIgnoreFile = require("clients/util/shouldIgnoreFile");

// Writes a file or folder from at a given path inside
// the blog's source folder. Needed to write preview files
// and source files for templates.
module.exports = function write(blogID, path, contents, callback) {
  debug("Blog", blogID, "Directory to write path inside:", path);

  if (shouldIgnoreFile(path)) {
    return callback(new Error(`Cannot write ignored file: ${path}`));
  }

  folder.write(blogID, path, contents).then(function () {
    callback(null);
  }, callback);
};
