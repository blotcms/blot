const fs = require("fs");
const crypto = require("crypto");
const { join, posix } = require("path");
const config = require("config");
const { GLOBAL_STATIC_DIR, isReservedStaticPath } = require("./staticPaths");

// A version for a CDN link to one of Blot's global static files (/icons,
// /katex, /plugins, ...): the first 8 characters of a SHA-256 of its bytes,
// sent as ?version=, the one query parameter the CDN caches by (see
// "Caching" in config/storage-bucket/README.md). So a release that changes a
// file gives it a new URL, which edges, Perma-Cache and browsers (which keep
// CDN files for a year) fetch afresh, and a release that leaves it alone
// leaves its URL alone. The CDN serves the file at the path whatever the
// version. The fonts' stylesheets carry their own (blog/static/fonts/build.js).
//
// The files ship with the release, so each is hashed once per process, the
// first time it's linked; in development it's re-hashed every time.

const cache = new Map();

// The version of the file at a reserved path, or null if it isn't one.
// `path` is decoded, without ?query or #hash.
function staticVersion(path) {
  const normalized = posix.normalize(path);

  // /fonts/../x only looks reserved
  if (!isReservedStaticPath(normalized)) return null;

  if (config.environment !== "development" && cache.has(normalized))
    return cache.get(normalized);

  let version = null;

  try {
    version = crypto
      .createHash("sha256")
      .update(fs.readFileSync(join(GLOBAL_STATIC_DIR, normalized)))
      .digest("hex")
      .slice(0, 8);
  } catch (err) {
    // Not a file: linked as written
  }

  cache.set(normalized, version);
  return version;
}

// The ?query and #hash to follow a link to the file at `path`, given the
// link's own `suffix` (its ?query and #hash, or ""). A link with a query of
// its own keeps it as written.
function staticSuffix(path, suffix = "") {
  if (suffix.startsWith("?")) return suffix;

  const version = staticVersion(path);

  return version ? "?version=" + version + suffix : suffix;
}

module.exports = { staticVersion, staticSuffix };
