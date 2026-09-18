const { getPage } = require("../../lib/models");
const projectEntryFields = require("./helpers/projectEntryFields");
const asRetriever = require("../../lib/asRetriever");
const LRUCache = require("lru-cache").LRUCache;
const { cloneDeep, prepareCacheValue } = require("../../lib/clone");
const cacheStats = require("../../lib/cacheStats");

const ALIASES = ["latestEntry", "latest_entry"];

const latestEntryCache = new LRUCache({
  max: 1000,
  // One full entry (including html) per blog; byte-cap so a few large
  // posts cannot dominate the process by item count alone.
  maxSize: 20 * 1024 * 1024,
  sizeCalculation: (value) => value.size,
});

function cloneEntry(value) {
  return cloneDeep(value, { preserveEntryInstances: true });
}

function createCacheKey(blog) {
  return JSON.stringify({
    blogID: String(blog && blog.id),
    cacheID: String(blog && blog.cacheID),
  });
}

async function latestEntry(req, res) {
  const log = typeof req?.log === "function" ? req.log.bind(req) : () => {};
  const key = createCacheKey(req.blog);

  if (latestEntryCache.has(key)) {
    log("Retrieved latest entry from cache");
    return projectEntryFields(
      cloneEntry(latestEntryCache.get(key).payload),
      req.retrieve,
      ALIASES,
    );
  }

  log("Loading latest entry");
  const { entries } = await getPage(req.blog.id, {
    pageNumber: 1,
    pageSize: 1,
  });
  log("Loaded latest entry");
  const latest = entries && entries.length ? entries[0] : {};

  // getPage can resolve to [] both for a genuinely empty blog and when
  // Entry.get swallows a failed MGET after a successful zRange - see
  // models/entry/get.js and entries handlePaginationAndCallback. Don't
  // cache an empty result; refetching a page of size 1 is cheap.
  if (entries && entries.length) {
    latestEntryCache.set(
      key,
      prepareCacheValue(latest, { preserveEntryInstances: true }),
    );
  }

  return projectEntryFields(cloneEntry(latest), req.retrieve, ALIASES);
}

module.exports = asRetriever(latestEntry);
module.exports._createCacheKey = createCacheKey;
module.exports._clear = function () {
  latestEntryCache.clear();
};
module.exports._stats = cacheStats("latestEntry", latestEntryCache);
