var debug = require("debug")("blot:clients:git:write");
var repo = require("./repo");
const shouldIgnoreFile = require("clients/util/shouldIgnoreFile");

// Used to write a file to the user's blog folder
// contents is a Buffer or a string, as storage/folder's write takes
module.exports = function write(blogID, path, contents, callback) {
  debug("Blog:", blogID, "Writing", path);

  if (shouldIgnoreFile(path)) {
    return callback(new Error(`Cannot write ignored file: ${path}`));
  }

  repo.commit(blogID, { path: path, contents: contents }, callback);
};
