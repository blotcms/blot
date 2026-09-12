const fingerprint = require("../../util/contentFingerprint");
const fs = require("fs-extra");
const { join } = require("path");

const localreaddir = async (dir) => {
  const contents = await fs.readdir(dir);

  return Promise.all(
    contents.map(async (name) => {
      const path = join(dir, name);
      const stat = await fs.stat(path, { bigint: true });

      // Convert the modification time to an ISO string
      const modifiedTime = stat.mtime.toISOString();
      const isDirectory = stat.isDirectory();
      const size = Number(stat.size);

      return {
        name,
        isDirectory,
        size,
        fingerprint: fingerprint(stat),
        modifiedTime: isDirectory ? undefined : modifiedTime,
      };
    })
  );
};

module.exports = localreaddir;
