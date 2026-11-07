var debug = require("debug")("blot:clients:git:write");
var repo = require("./repo");
const shouldIgnoreFile = require("clients/util/shouldIgnoreFile");

// Used to write a file to the user's blog folder
// contents is a Buffer or a string, as storage/folder's write takes
async function write(blogID, path, contents) {
  debug("Blog:", blogID, "Writing", path);

  if (shouldIgnoreFile(path)) {
    throw new Error(`Cannot write ignored file: ${path}`);
  }

  await repo.commit(blogID, { path: path, contents: contents });
}

module.exports = write;
