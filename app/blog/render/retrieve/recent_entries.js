const { getRecent } = require("../../lib/models");
const projectEntryFields = require("./helpers/projectEntryFields");
const asRetriever = require("../../lib/asRetriever");
const { createRenderCache, timeClone } = require("../../lib/cacheMetrics");
const { cloneDeep, prepareCacheValue } = require("../../lib/clone");
const cacheStats = require("../../lib/cacheStats");
const fetchCached = require("../../lib/fetchCached");
const { Uncacheable } = require("../../lib/uncacheableFetch");

const ALIASES = ["recentEntries", "recent_entries"];

// The RSS feed view is fetched by pollers far more often than pages are, so
// it carries fewer entries than the 30 other views get.
const FEED_VIEW_NAME = "feed.rss";
const FEED_MAX_ENTRIES = 10;

const recentEntriesCache = createRenderCache("recentEntries", {
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

  let prepared;
  try {
    prepared = await fetchCached(recentEntriesCache, "recentEntries", log, key, {
      context: { blogID: req.blog.id },
    });
  } catch (e) {
    if (!(e instanceof Uncacheable)) throw e;
    prepared = e.payload;
  }

  let entries = prepared.payload;

  // Slice at use: the cached payload is shared by every view of this blog.
  if (req.viewName === FEED_VIEW_NAME && entries.length > FEED_MAX_ENTRIES) {
    entries = entries.slice(0, FEED_MAX_ENTRIES);
  }

  return projectEntryFields(
    timeClone(recentEntriesCache, () => cloneEntries(entries)),
    req.retrieve,
    ALIASES
  );
}

module.exports = asRetriever(recentEntries);
module.exports.FEED_MAX_ENTRIES = FEED_MAX_ENTRIES;
module.exports._createCacheKey = createCacheKey;
module.exports._clear = function () {
  recentEntriesCache.clear();
};
module.exports._stats = cacheStats("recentEntries", recentEntriesCache);
