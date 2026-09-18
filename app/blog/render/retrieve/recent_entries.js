const { getRecent } = require("../../lib/models");
const projectEntryFields = require("./helpers/projectEntryFields");
const asRetriever = require("../../lib/asRetriever");
const LRUCache = require("lru-cache").LRUCache;
const { cloneDeep, prepareCacheValue } = require("../../lib/clone");
const cacheStats = require("../../lib/cacheStats");

const ALIASES = ["recentEntries", "recent_entries"];

const recentEntriesCache = new LRUCache({
  max: 1000,
  // 30 skinny entries per blog, but still byte-capped so a burst of
  // distinct blogs cannot fill the process by item count alone.
  maxSize: 20 * 1024 * 1024,
  sizeCalculation: (value) => value.size,
});

function cloneEntries(value) {
  return cloneDeep(value, { preserveEntryInstances: true });
}

function createCacheKey(blog) {
  return JSON.stringify({
    blogID: String(blog && blog.id),
    cacheID: String(blog && blog.cacheID),
  });
}

async function recentEntries(req, res) {
  const log = typeof req?.log === "function" ? req.log.bind(req) : () => {};
  const key = createCacheKey(req.blog);

  if (recentEntriesCache.has(key)) {
    log("Retrieved recent entries from cache");
    return projectEntryFields(
      cloneEntries(recentEntriesCache.get(key).payload),
      req.retrieve,
      ALIASES,
    );
  }

  const recent = await getRecent(req.blog.id);

  // Entries.getRecent swallows transient Redis failures (a failed zRange
  // or zCard) by resolving to [] rather than rejecting - see
  // models/entries/index.js getRange / getRecent. Caching that [] would
  // look identical to a genuinely empty blog and hide every post until
  // the cacheID changes. Only cache non-empty results.
  if (recent.length > 0) {
    recentEntriesCache.set(
      key,
      prepareCacheValue(recent, { preserveEntryInstances: true }),
    );
  }

  return projectEntryFields(recent, req.retrieve, ALIASES);
}

module.exports = asRetriever(recentEntries);
module.exports._createCacheKey = createCacheKey;
module.exports._clear = function () {
  recentEntriesCache.clear();
};
module.exports._stats = cacheStats("recentEntries", recentEntriesCache);
