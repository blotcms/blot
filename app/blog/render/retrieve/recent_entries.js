const { getRecent } = require("../../lib/models");
const projectEntryFields = require("./helpers/projectEntryFields");
const asRetriever = require("../../lib/asRetriever");
const LRUCache = require("lru-cache").LRUCache;
const { cloneDeep, prepareCacheValue } = require("../../lib/clone");
const cacheStats = require("../../lib/cacheStats");
const { Uncacheable } = require("../../lib/uncacheableFetch");

const ALIASES = ["recentEntries", "recent_entries"];

const recentEntriesCache = new LRUCache({
  max: 1000,
  // 30 skinny entries per blog, but still byte-capped so a burst of
  // distinct blogs cannot fill the process by item count alone.
  maxSize: 20 * 1024 * 1024,
  sizeCalculation: (value) => value.size,
  // Without this, an in-flight fetch evicted by LRU/size pressure aborts and
  // every request coalesced onto it rejects with "Error: evicted" instead
  // of getting its entries - let the already-running getRecent call finish
  // and hand its result back even if it can't be cached.
  ignoreFetchAbort: true,
  // Coalesce concurrent misses on the same key into one in-flight
  // getRecent call.
  fetchMethod: async (key, staleValue, { context }) => {
    const recent = await getRecent(context.blogID);
    const prepared = prepareCacheValue(recent, { preserveEntryInstances: true });

    // Entries.getRecent swallows transient Redis failures (a failed zRange
    // or zCard) by resolving to [] rather than rejecting - see
    // models/entries/index.js getRange / getRecent. Caching that [] would
    // look identical to a genuinely empty blog and hide every post until
    // the cacheID changes. Uncacheable still hands the (possibly empty)
    // result back without writing it to the cache.
    if (recent.length === 0) {
      throw new Uncacheable(prepared);
    }

    return prepared;
  },
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

  const status = {};
  let prepared;
  try {
    prepared = await recentEntriesCache.fetch(key, {
      status,
      context: { blogID: req.blog.id },
    });
  } catch (e) {
    if (!(e instanceof Uncacheable)) throw e;
    prepared = e.payload;
  }

  if (status.fetch === "hit") log("Retrieved recent entries from cache");

  return projectEntryFields(cloneEntries(prepared.payload), req.retrieve, ALIASES);
}

module.exports = asRetriever(recentEntries);
module.exports._createCacheKey = createCacheKey;
module.exports._clear = function () {
  recentEntriesCache.clear();
};
module.exports._stats = cacheStats("recentEntries", recentEntriesCache);
