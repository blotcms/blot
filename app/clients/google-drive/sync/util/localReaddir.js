const folder = require("storage/folder");

// The entries of a directory in the blog's folder, from storage/folder's
// metadata alone, so it reads nothing and works the same on either backend.
// modified is in milliseconds, as storage/folder gives it; modifiedTime is
// the same as an ISO string, for the comparisons with Drive's modifiedTime.
// Rejects with ENOENT for a missing directory.
const localreaddir = async (blogID, dir) => {
  const contents = await folder.listAll(blogID, dir);

  return contents.map(({ name, isDirectory, size, modified }) => ({
    name,
    isDirectory,
    size,
    modified,
    modifiedTime: isDirectory ? undefined : new Date(modified).toISOString(),
  }));
};

module.exports = localreaddir;
