const folder = require("storage/folder");

// The blog paths of everything inside a folder of the blog, parents before
// their contents, or [] if it isn't a folder. A sync walk removes a folder
// that's gone remotely with one remove, but update() on the folder's path
// drops nothing beneath it, so the walk must update each of these paths too.
// Otherwise the entries for the files inside stay published until Fix()
// finds them missing.
module.exports = async function localDescendants(blogID, path) {
  const paths = [];

  try {
    for await (const item of folder.walk(blogID, path, { directories: true })) {
      paths.push(item);
    }
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return [];
    throw err;
  }

  return paths;
};
