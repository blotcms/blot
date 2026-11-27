var fs = require("fs-extra");
var crypto = require("crypto");
var debug = require("debug")("blot:helper:transformer:hash");

async function hash(path) {
  var hasher = crypto.createHash("sha1");

  for await (var chunk of fs.createReadStream(path)) hasher.update(chunk);

  var digest = hasher.digest("hex");
  debug(path, "hashed to", digest);
  return digest;
}

// The same hash, of bytes held in memory
hash.buffer = function (buffer) {
  return crypto.createHash("sha1").update(buffer).digest("hex");
};

module.exports = hash;
