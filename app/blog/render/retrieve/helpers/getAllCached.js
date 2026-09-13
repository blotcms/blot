// Process-local cache for Entries.getAll, shared by archives.js and
// all_entries.js. Both currently MGET the full entry catalog independently;
// routing them through this module means a request (or a burst of requests)
// that needs both locals only pays for one Redis round trip per cacheID, and
// repeat renders hit the LRU instead of Redis at all.
const LRUCache = require("lru-cache").LRUCache;
const { getAll } = require("../../../lib/models");
const { cloneDeep, deepFreeze } = require("../../../lib/clone");

const entriesCache = new LRUCache({
  max: 200,
  // Byte-capped like the posts/popular_tags caches: a single large blog's
  // full catalog must not evict every other blog sharing this process.
  maxSize: 100 * 1024 * 1024,
  sizeCalculation: (value) => JSON.stringify(value).length,
});

// Dedupes concurrent misses for the same key (e.g. archives and all_entries
// both missing on the same request) so only one Entries.getAll is in flight -
// even for preview requests, which skip persisting to entriesCache below but
// still benefit from not double-fetching within the same request.
const inflight = new Map();

function createCacheKey(blog) {
  return JSON.stringify({
    blogID: String(blog && blog.id),
    cacheID: String(blog && blog.cacheID),
  });
}

function cloneEntries(value) {
  return cloneDeep(value, { preserveEntryInstances: true });
}

// options.bypassCache: skip reading/writing entriesCache entirely. Used for
// preview renders (req.preview) - a template being edited in preview changes
// on every keystroke/save, so caching its output would either serve stale
// entries or thrash the LRU with one-shot entries no other request will ever
// read again. Concurrent calls still share one in-flight fetch.
async function getAllCached(blog, options) {
  const bypassCache = !!(options && options.bypassCache);
  const key = createCacheKey(blog);

  if (!bypassCache && entriesCache.has(key)) {
    return cloneEntries(entriesCache.get(key));
  }

  if (inflight.has(key)) {
    return cloneEntries(await inflight.get(key));
  }

  const promise = getAll(blog && blog.id).then((entries) => {
    const immutableCopy = deepFreeze(cloneEntries(entries));
    // Entries.getAll swallows transient Redis failures (a failed zRange or
    // mGet) by resolving to [] rather than rejecting - see
    // models/entries/index.js's getRange. Caching that [] would look
    // identical to a genuinely empty blog and silently hide every post
    // until the cacheID changes or the LRU entry is evicted. Only cache
    // non-empty results; an empty catalog always re-hits Redis, which is
    // cheap.
    if (!bypassCache && immutableCopy.length > 0) {
      entriesCache.set(key, immutableCopy);
    }
    return immutableCopy;
  });

  inflight.set(key, promise);

  try {
    return cloneEntries(await promise);
  } finally {
    inflight.delete(key);
  }
}

module.exports = getAllCached;
module.exports._createCacheKey = createCacheKey;
module.exports._clear = function () {
  entriesCache.clear();
  inflight.clear();
};
