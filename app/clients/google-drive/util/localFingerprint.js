const fs = require("fs-extra");
const folder = require("storage/folder");
const contentFingerprint = require("./contentFingerprint");

// Fingerprint of the file currently at path in the blog's folder, or null if
// it can't be read. The nanosecond mtime comes from a bigint stat of the local
// file: storage/folder's stat only has milliseconds, which could not match the
// fingerprints already stored.
module.exports = async function localFingerprint(blogID, path) {
  try {
    const file = await folder.ensureLocal(blogID, path);
    return contentFingerprint(await fs.stat(file, { bigint: true }));
  } catch (e) {
    return null;
  }
};
