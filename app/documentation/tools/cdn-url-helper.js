const fs = require("fs-extra");
const hash = require("helper/hash");
const config = require("config");
const { join } = require("path");

// Create a cache object to store the results
const cache = {};

module.exports = ({ cacheID, viewDirectory }) => {
  return () => (text, render) => {
    const path = render(text);
    const cacheKey = `${cacheID}-${path}`;
    const file = join(viewDirectory, path);
    let cached = cache[cacheKey];

    // In development the underlying file can change (e.g. a CSS rebuild)
    // without the server restarting, so re-hash when it has changed rather
    // than trusting a hash computed once at process start.
    if (cached && config.environment === "development") {
      try {
        const { mtimeMs, size } = fs.statSync(file);
        if (cached.mtimeMs !== mtimeMs || cached.size !== size) cached = null;
      } catch (e) {
        cached = null;
      }
    }

    let identifier = cached && cached.identifier;

    if (!identifier) {
      try {
        const { mtimeMs, size } = fs.statSync(file);
        identifier = hash(fs.readFileSync(file, "utf8")).slice(0, 8);

        // Cache the result for future use
        cache[cacheKey] = { identifier, mtimeMs, size };
      } catch (e) {
        console.log("failed to hash", path, e);
        // if the file doesn't exist, we'll use the cacheID
        identifier = cacheID;
      }
    }

    return `${config.cdn.origin}/documentation/v-${identifier}${path}`;
  };
};
