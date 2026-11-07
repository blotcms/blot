const debug = require("debug")("blot:clients:local:remove");
const fs = require("fs-extra");
const folder = require("storage/folder");
const source = require("./source");

// Removes a file or folder from at a given path inside
// the blog's source folder. Needed to remove preview files
// and source files for templates. Removed from the source
// directory and from storage/folder; a missing path is a no-op.
async function remove(blogID, path) {
  debug("Blog", blogID, "Removing", path);

  const dir = await source.directory(blogID);
  const target = source.absolute(dir, path);
  if (target === dir) throw new Error("Cannot remove the source directory");
  await fs.remove(target);
  await folder.remove(blogID, path);
}

const promiseOnly = require("helper/promiseOnly");

module.exports = promiseOnly(remove);
