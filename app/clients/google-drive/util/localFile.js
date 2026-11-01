const folder = require("storage/folder");

// The local path of a file in the blog folder, for tools which read from a
// path (md5, stat), or null if there is no such file. Anything other than a
// missing file (a symlink, a failing disk) is thrown, never taken for "gone".
module.exports = async function localFile(blogID, path) {
  try {
    return await folder.ensureLocal(blogID, path);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
};
