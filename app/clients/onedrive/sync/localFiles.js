const fs = require("fs-extra");
const { join } = require("path");
const sha1File = require("../util/sha1File");

// Lists a local directory in the same shape as graph.listChildren so the
// two can be compared. Hashes files so identical ones can be skipped.
module.exports = async function localReaddir(localRoot, dir) {
  const names = await fs.readdir(join(localRoot, dir));

  return Promise.all(
    names.map(async function (name) {
      const path = join(localRoot, dir, name);
      const stat = await fs.stat(path);

      return {
        name,
        is_directory: stat.isDirectory(),
        size: stat.size,
        sha1: stat.isDirectory() ? undefined : await sha1File(path),
      };
    })
  );
};
