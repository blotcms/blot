const fs = require("fs").promises;
const { resolve, relative, sep } = require("path");

// Defense in depth for existing trees. This is not an atomic filesystem
// sandbox: ingestion must also prevent untrusted clients from creating links.
module.exports = async function assertNoSymlinks(root, filename) {
  root = resolve(root);
  const suffix = relative(root, resolve(filename));
  if (suffix === ".." || suffix.startsWith(".." + sep)) {
    throw new Error("Path is outside the blog folder");
  }
  let current = root;
  for (const segment of ["", ...suffix.split(sep).filter(Boolean)]) {
    if (segment) current = resolve(current, segment);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (err) {
      // Missing paths are handled by the caller (including deletion updates).
      if (err.code === "ENOENT") return;
      throw err;
    }
    if (stat.isSymbolicLink()) {
      const err = new Error("Symbolic links are not supported in blog folders");
      err.code = "ELOOP";
      throw err;
    }
  }
};
