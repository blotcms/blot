const fs = require("fs-extra");
const fingerprint = require("./contentFingerprint");
const checksum = require("./md5Checksum");

// { checksum, sha1 } of the file at filename, a real local path, when its MD5
// is expected, or null if it isn't, or there's no such file, or it changed
// while it was read (the fingerprints of the path before and after differ).
// Both hashes come from one read.
module.exports = async function verifyContent(filename, expected) {
  if (!expected) return null;
  let before;
  try {
    before = fingerprint(await fs.stat(filename, { bigint: true }));
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
    throw err;
  }
  if (!before) return null;
  const actual = await checksum.withSha1(filename);
  let after;
  try {
    after = fingerprint(await fs.stat(filename, { bigint: true }));
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
    throw err;
  }
  return actual && actual.md5 === expected && before === after
    ? { checksum: actual.md5, sha1: actual.sha1 }
    : null;
};
