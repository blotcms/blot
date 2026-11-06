// getCachedRecent(blogID, options): getRecent's most recent entries, cached
// in this process per blog cacheID, for rendering.
//
// options.limit: how many of them the caller needs (all when left out); only
// those are copied.
// options.cacheID: the blog's cacheID, when the caller already has it. Read
// from Redis otherwise (the client-side cache usually answers that locally).
// options.log: req.log, told how the lookup was served (models/cache/fetchCached).
//
// Resolves to a copy the caller may change. Only for rendering: the cacheID
// can lag a write by the moment it takes to bump, so code that writes back
// what it read (sync, fix, scripts) must use getRecent.
const { cloneDeep, prepareCacheValue } = require("models/cache/clone");
const cacheStats = require("models/cache/stats");
const fetchCached = require("models/cache/fetchCached");
const { Uncacheable } = require("models/cache/uncacheable");
const { createRenderCache, timeClone } = require("models/cache/metrics");
const client = require("models/client");
const blogKey = require("models/blog/key");

const recentEntriesCache = createRenderCache("recentEntries", {
  max: 1000,
  // 31 entries per blog, but still byte-capped so a burst of distinct blogs
  // cannot fill the process by item count alone.
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
    // Required here: models/entries requires this module (and specs spy
    // on getRecent). rejectOnOutage makes a Redis outage reject rather than
    // resolve [].
    const recent = await require("models/entries").getRecent(context.blogID, {
      rejectOnOutage: true,
    });
    const prepared = prepareCacheValue(recent, {
      preserveEntryInstances: true,
    });

    // getRecent still swallows other Redis failures (a failed zRange or
    // zCard) by resolving to [] - see getRange / getRecent in ./index.js.
    // Caching that [] would look identical to a genuinely empty blog and hide
    // every post until the cacheID changes. Uncacheable still hands the
    // (possibly empty) result back without writing it to the cache.
    if (recent.length === 0) {
      throw new Uncacheable(prepared);
    }

    return prepared;
  },
});

function createCacheKey(blogID, cacheID) {
  return JSON.stringify({
    blogID: String(blogID),
    cacheID: String(cacheID),
  });
}

async function getCachedRecent(blogID, options = {}) {
  const cacheID =
    options.cacheID !== undefined
      ? options.cacheID
      : await client.hGet(blogKey.info(blogID), "cacheID");
  const key = createCacheKey(blogID, cacheID);

  let prepared;
  try {
    prepared = await fetchCached(
      recentEntriesCache,
      "recentEntries",
      options.log,
      key,
      {
        context: { blogID },
      }
    );
  } catch (e) {
    if (!(e instanceof Uncacheable)) throw e;
    prepared = e.payload;
  }

  let entries = prepared.payload;
  if (options.limit !== undefined && entries.length > options.limit) {
    entries = entries.slice(0, options.limit);
  }

  return timeClone(recentEntriesCache, () =>
    cloneDeep(entries, { preserveEntryInstances: true })
  );
}

module.exports = getCachedRecent;
module.exports._createCacheKey = createCacheKey;
module.exports._clear = function () {
  recentEntriesCache.clear();
};
module.exports._stats = cacheStats("recentEntries", recentEntriesCache);
