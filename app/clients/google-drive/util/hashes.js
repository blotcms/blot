// Drive's md5Checksum of each file in the blog's folder, by the file's SHA-1
// (clients/util/remoteHashes.js), so a walk knows a file is unchanged without
// reading it, wherever in the folder it now is
module.exports = require("clients/util/remoteHashes")("google-drive");
