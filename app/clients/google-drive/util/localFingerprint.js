const fs = require("fs-extra");
const contentFingerprint = require("./contentFingerprint");

// Fingerprint of the file currently at path, or null if it can't be read.
module.exports = async function localFingerprint(path) {
  try {
    return contentFingerprint(await fs.stat(path, { bigint: true }));
  } catch (e) {
    return null;
  }
};
