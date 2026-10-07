const fs = require("fs-extra");
const { join } = require("path");

// The blog paths of everything inside a local folder, parents before their
// contents, or [] if it isn't a folder. A sync walk removes a folder that's
// gone remotely with one fs.remove, but update() on the folder's path drops
// nothing beneath it, so the walk must update each of these paths too.
// Otherwise the entries for the files inside stay published until Fix()
// finds them missing.
module.exports = async function localDescendants(directory, path) {
  let contents;

  try {
    contents = await fs.readdir(directory, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return [];
    throw err;
  }

  const paths = [];

  for (const item of contents) {
    paths.push(join(path, item.name));
    if (item.isDirectory()) {
      paths.push(
        ...(await localDescendants(join(directory, item.name), join(path, item.name)))
      );
    }
  }

  return paths;
};
