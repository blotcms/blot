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

// Caches a file's content hash by path+size+mtimeMs, so a rebuild that
// re-checks a large, unchanged file doesn't have to re-read and re-hash it.
// Bounded (simple insertion-order eviction) so it can't grow without limit;
// entries just fall out and get recomputed, they're never invalidated.
const MAX_CACHE_ENTRIES = 5000;
const cache = new Map();

function cacheGet(key) {
  return cache.get(key);
}

function cacheSet(key, value) {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, value);
}

// Returns an 8-character hex digest of a file's contents, given its path
// and an already-fetched fs.Stats. Used to build CDN version tokens that
// only change when a file's content changes (not its mtime/ctime, which
// aren't meaningful once blog folders can live on S3).
module.exports = async function contentVersion(filePath, stat) {
  const cacheKey = `${filePath}:${stat.size}:${stat.mtimeMs}`;
  const cached = cacheGet(cacheKey);

  if (cached) return cached;

  let version;

  if (stat.size <= SMALL_FILE_HASH_SIZE) {
    const buffer = await fs.readFile(filePath);
    version = crypto.createHash("sha1").update(buffer).digest("hex").slice(0, 8);
  } else {
    const digest = await hashFileAsync(filePath);
    version = digest.slice(0, 8);
  }

  cacheSet(cacheKey, version);

  return version;
};
