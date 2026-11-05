const debug = require("debug")("blot:clients:local:write");
const fs = require("fs-extra");
const folder = require("storage/folder");
const shouldIgnoreFile = require("clients/util/shouldIgnoreFile");
const source = require("./source");

async function toBuffer(contents) {
  if (typeof contents === "string" || Buffer.isBuffer(contents)) return contents;
  const chunks = [];
  for await (const chunk of contents) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

// Writes a file or folder from at a given path inside
// the blog's source folder. Needed to write preview files
// and source files for templates. The file goes to the source
// directory first, so the watcher finds it already in the folder,
// and then to storage/folder.
module.exports = function write(blogID, path, contents, callback) {
  debug("Blog", blogID, "Directory to write path inside:", path);

  if (shouldIgnoreFile(path)) {
    return callback(new Error(`Cannot write ignored file: ${path}`));
  }

  (async function () {
    const dir = await source.directory(blogID);
    contents = await toBuffer(contents);
    await fs.outputFile(source.absolute(dir, path), contents);
    await folder.write(blogID, path, contents);
  })().then(function () {
    callback(null);
  }, callback);
};
