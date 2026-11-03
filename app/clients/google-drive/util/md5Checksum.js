const crypto = require("crypto");
const fs = require("fs");

// Resolves to { md5, sha1 } of the file at path, in hex, from one read, or
// null if it can't be read
const hashes = function (path) {
  return new Promise(function (resolve) {
    const md5 = crypto.createHash("md5");
    const sha1 = crypto.createHash("sha1");
    const input = fs.createReadStream(path);

    // Suppress errors, esp. ENOENT and EISDIR
    input.on("error", function () {
      resolve(null);
    });

    input.on("data", function (chunk) {
      md5.update(chunk);
      sha1.update(chunk);
    });

    input.on("end", function () {
      resolve({ md5: md5.digest("hex"), sha1: sha1.digest("hex") });
    });
  });
};

module.exports = async function getChecksum(path) {
  const result = await hashes(path);
  return result ? result.md5 : null;
};

module.exports.withSha1 = hashes;
