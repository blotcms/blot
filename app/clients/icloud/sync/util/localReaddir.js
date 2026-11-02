const folder = require("storage/folder");

// A symlink is not listed (storage/folder never follows one); a directory has
// no size.
const localreaddir = async (blogID, dir) => {
  const contents = await folder.listAll(blogID, dir);

  return contents.map(({ name, isDirectory, size }) => ({
    name,
    isDirectory,
    size: isDirectory ? undefined : size,
  }));
};

module.exports = localreaddir;
