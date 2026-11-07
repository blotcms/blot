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

module.exports = hash;
