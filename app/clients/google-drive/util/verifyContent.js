const fs = require("fs-extra");
const fingerprint = require("./contentFingerprint");
const checksum = require("./md5Checksum");

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
  const actual = await checksum(filename);
  let after;
  try {
    after = fingerprint(await fs.stat(filename, { bigint: true }));
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
    throw err;
  }
  return actual === expected && before === after
    ? { checksum: actual, fingerprint: after }
    : null;
};
