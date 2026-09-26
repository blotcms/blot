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

    // In development the underlying file can change (e.g. a CSS rebuild)
    // without the server restarting, so re-hash on every request rather
    // than trusting a hash computed once at process start.
    let identifier =
      config.environment === "development" ? null : cache[cacheKey];

    if (!identifier) {
      try {
        const contents = fs.readFileSync(join(viewDirectory, path), "utf8");
        identifier = hash(contents).slice(0, 8);
        // console.log('hashed', path, identifier);

        // Cache the result for future use
        cache[cacheKey] = identifier;
      } catch (e) {
        console.log("failed to hash", path, e);
        // if the file doesn't exist, we'll use the cacheID
        identifier = cacheID;
      }
    }

    return `${config.cdn.origin}/documentation/v-${identifier}${path}`;
  };
};