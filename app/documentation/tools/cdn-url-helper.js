const fs = require("fs-extra");
const hash = require("helper/hash");
const config = require("config");
const { join } = require("path");

// The version in a file's CDN URL, /documentation/v-<version><path>: the
// first 8 characters of a hash of its contents, so a deploy that leaves a
// file alone leaves its URL alone. A file that can't be read gets "missing",
// the same on every boot: the CDN serves whatever is at the path, whatever
// the version, so a stable URL is all that matters, and the boot's cacheID
// that was used before gave such a file a new URL, and a new Perma-Cache
// copy, on every deploy. The Perma-Cache sweep (cdn/permaCache) uses this to
// tell a stale copy from the current one.
function versionOf(viewDirectory, path) {
  try {
    return hash(fs.readFileSync(join(viewDirectory, path), "utf8")).slice(0, 8);
  } catch (e) {
    return null;
  }
}

const MISSING = "missing";

// Create a cache object to store the results
const cache = {};

const helper = ({ cacheID, viewDirectory }) => {
  return () => (text, render) => {
    const path = render(text);
    const cacheKey = `${cacheID}-${path}`;

    // In development the underlying file can change (e.g. a CSS rebuild)
    // without the server restarting, so re-hash on every request rather
    // than trusting a hash computed once at process start.
    let identifier =
      config.environment === "development" ? null : cache[cacheKey];

    if (!identifier) {
      identifier = versionOf(viewDirectory, path);

      if (!identifier) {
        console.log("failed to hash", path);
        identifier = MISSING;
      }

      cache[cacheKey] = identifier;
    }

    return `${config.cdn.origin}/documentation/v-${identifier}${path}`;
  };
};

helper.versionOf = versionOf;
helper.MISSING = MISSING;

module.exports = helper;
