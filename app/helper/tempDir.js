var fs = require("fs-extra");
var tempDir = require("config").tmp_directory + "/";

// Ensure tmp dir exists
fs.ensureDirSync(tempDir);

// The temporary directory, with a trailing slash
function getTempDir() {
  return tempDir;
}

// Resolves with whether the path (once symlinks are resolved) is inside the
// temporary directory. Throws if the path does not exist.
getTempDir.isInside = async function isInside(checkPath) {
  var resolvedPath;

  try {
    resolvedPath = await fs.realpath(checkPath);
  } catch (err) {
    throw new Error("The path does not point to a file: " + checkPath, {
      cause: err,
    });
  }

  return resolvedPath.indexOf(tempDir) === 0;
};

module.exports = getTempDir;
