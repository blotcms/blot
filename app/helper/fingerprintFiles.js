const crypto = require("crypto");
const fs = require("fs-extra");
const { join } = require("path");

// Each file under a path, or the path itself when it is a file. A missing path
// has no files.
async function list(path) {
  const stat = await fs.stat(path).catch((err) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });

  if (!stat) return [];
  if (!stat.isDirectory()) return [[path, stat]];

  const names = await fs.readdir(path);
  const files = await Promise.all(names.map((name) => list(join(path, name))));
  return files.flat();
}

// A hash of the name, size and modification time of every file under the paths:
// it changes when any of them does, without reading their contents.
module.exports = async function fingerprintFiles(paths) {
  const hash = crypto.createHash("sha256");
  const files = (await Promise.all(paths.map(list))).flat();

  files
    .map(([path, stat]) => [path, stat.mtimeMs, stat.size].join(":"))
    .sort()
    .forEach((line) => hash.update(line + "\n"));

  return hash.digest("hex");
};
