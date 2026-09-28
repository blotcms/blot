const fs = require("fs-extra");
const crypto = require("crypto");
const { promisify } = require("util");
const hashFileAsync = promisify(require("./transformer/hash"));

// Below this, read the whole file into memory and hash it synchronously
// instead of going through helper/transformer/hash's readable-stream
// pipeline. Most callers point at small images/fonts, and a stream's
// setup/event overhead measurably dominates the hash itself at this size -
// a single buffered read+digest is faster in practice.
const SMALL_FILE_HASH_SIZE = 256 * 1024;

// Above this, skip content hashing and fall back to a token derived from
// size+mtime, so a build - or, for lookupFile.js, a page's first render -
// doesn't have to read a huge video/audio file just to version its URL.
// This still leans on a settable local mtime, but only as a cheap nudge for
// large files: a local mtime always changes when a file's content does, so
// it's a safe enough fingerprint here (unlike ctime, which this module
// never reads). Once blog folders live on S3, this branch is replaced by
// the object's own ETag, which S3 provides for free.
const MAX_CONTENT_HASH_SIZE = 5 * 1024 * 1024;

// Returns an 8-character hex digest identifying a file's contents, given
// its path and an already-fetched fs.Stats. Used to build CDN version
// tokens that only change when a file's content changes.
module.exports = async function contentVersion(filePath, stat) {
  if (stat.size > MAX_CONTENT_HASH_SIZE) {
    return statToken(stat);
  }

  try {
    if (stat.size <= SMALL_FILE_HASH_SIZE) {
      const buffer = await fs.readFile(filePath);
      return crypto.createHash("sha1").update(buffer).digest("hex").slice(0, 8);
    }

    const digest = await hashFileAsync(filePath);
    return digest.slice(0, 8);
  } catch (err) {
    // The file existed a moment ago (the caller already stat'd it) but
    // became unreadable before we could hash it - a rare local race, not
    // worth failing the whole build/render over.
    return statToken(stat);
  }
};

function statToken(stat) {
  return crypto
    .createHash("sha1")
    .update(`${stat.size}:${stat.mtimeMs}`)
    .digest("hex")
    .slice(0, 8);
}
