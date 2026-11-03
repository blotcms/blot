const fs = require("fs-extra");
const folder = require("storage/folder");
const contentFingerprint = require("./contentFingerprint");

// Fingerprint of the file currently at path in the blog's folder, or null if
// it can't be read. The nanosecond mtime comes from a bigint stat of the local
// file: storage/folder's stat only has milliseconds, which could not match the
// fingerprints already stored. Only for records written before the client
// kept each file's size and modified time (./localState.js), so it can tell
// whether one of them still holds. On S3 the local file is the content
// cache's copy, whose mtime is new, so it never matches there.
module.exports = async function localFingerprint(blogID, path) {
  try {
    const file = await folder.ensureLocal(blogID, path);
    return contentFingerprint(await fs.stat(file, { bigint: true }));
  } catch (e) {
    return null;
  }
};
