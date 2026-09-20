const fs = require("fs");
const crypto = require("crypto");

// Personal OneDrive reports each file's SHA-1 (uppercase hex), so we
// compare that with the local file to skip files that are already identical.
module.exports = function sha1File(path) {
  return new Promise(function (resolve, reject) {
    const hash = crypto.createHash("sha1");

    fs.createReadStream(path)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex").toUpperCase()));
  });
};
