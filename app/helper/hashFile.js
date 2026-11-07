// https://github.com/dropbox/dropbox-api-content-hasher
// Computes a hash using the same algorithm that the Dropbox API uses for the
// the "content_hash" metadata field.
const fs = require("fs");
const stream = require("stream");
const { pipeline } = require("stream/promises");
const crypto = require("crypto");
const BLOCK_SIZE = 4 * 1024 * 1024;

async function hashFile(path) {
  const writableStream = new stream.Writable();
  const read = fs.createReadStream(path);

  let blockPos = 0;
  let overallHasher = crypto.createHash("sha256");
  let blockHasher = crypto.createHash("sha256");
  let hash;

  writableStream._write = (data, encoding, next) => {
    let offset = 0;
    while (offset < data.length) {
      if (blockPos === BLOCK_SIZE) {
        overallHasher.update(blockHasher.digest());
        blockHasher = crypto.createHash("sha256");
        blockPos = 0;
      }
      let spaceInBlock = BLOCK_SIZE - blockPos;
      let inputPartEnd = Math.min(data.length, offset + spaceInBlock);
      let inputPartLength = inputPartEnd - offset;
      blockHasher.update(data.slice(offset, inputPartEnd));
      blockPos += inputPartLength;
      offset = inputPartEnd;
    }
    next();
  };

  writableStream.on("finish", () => {
    if (blockPos > 0) {
      overallHasher.update(blockHasher.digest());
    }
    hash = overallHasher.digest("hex");
  });

  await pipeline(read, writableStream);
  return hash;
}

module.exports = hashFile;
