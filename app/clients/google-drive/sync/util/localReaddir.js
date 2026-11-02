const fingerprint = require("../../util/contentFingerprint");
const folder = require("storage/folder");
const fs = require("fs-extra");
const { join } = require("path");

const localreaddir = async (blogID, dir) => {
  // The directory's real place: the fingerprint has a nanosecond mtime, which
  // storage/folder's stat (milliseconds) could not give
  const base = await folder.ensureLocal(blogID, dir);
  const contents = await folder.listNames(blogID, dir);

  return Promise.all(
    contents.map(async ({ name }) => {
      const path = join(base, name);
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
