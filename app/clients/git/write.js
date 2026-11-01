var debug = require("debug")("blot:clients:git:write");
var repo = require("./repo");
const shouldIgnoreFile = require("clients/util/shouldIgnoreFile");

// Used to write a file to the user's blog folder
// contents can be anything supported by fs-extra.outputFile
// which I believe includes buffers and utf8 strings.
module.exports = function write(blogID, path, contents, callback) {
  debug("Blog:", blogID, "Writing", path);

  if (shouldIgnoreFile(path)) {
    return callback(new Error(`Cannot write ignored file: ${path}`));
  }

  repo.commit(blogID, { path: path, contents: contents }, callback);
};
