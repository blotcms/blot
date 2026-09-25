const { getPage } = require("../../lib/models");
const projectEntryFields = require("./helpers/projectEntryFields");
const asRetriever = require("../../lib/asRetriever");
const LRUCache = require("lru-cache").LRUCache;
const { cloneDeep, prepareCacheValue } = require("../../lib/clone");
const cacheStats = require("../../lib/cacheStats");
const { Uncacheable } = require("../../lib/uncacheableFetch");

const ALIASES = ["latestEntry", "latest_entry"];

const latestEntryCache = new LRUCache({
  max: 1000,
  // One full entry (including html) per blog; byte-cap so a few large
  // posts cannot dominate the process by item count alone.
  maxSize: 20 * 1024 * 1024,
  sizeCalculation: (value) => value.size,
  // Without this, an in-flight fetch evicted by LRU/size pressure aborts and
  // every request coalesced onto it rejects with "Error: evicted" instead
  // of getting its entry - let the already-running getPage call finish and
  // hand its result back even if it can't be cached.
  ignoreFetchAbort: true,
  // Coalesce concurrent misses on the same key into one in-flight
  // getPage call.
  fetchMethod: async (key, staleValue, { context }) => {
    const { blogID, log } = context;

    log("Loading latest entry");
    const { entries } = await getPage(blogID, { pageNumber: 1, pageSize: 1 });
    log("Loaded latest entry");
    const latest = entries && entries.length ? entries[0] : {};

    const prepared = prepareCacheValue(latest, { preserveEntryInstances: true });

    // getPage can resolve to [] both for a genuinely empty blog and when
    // Entry.get swallows a failed MGET after a successful zRange - see
    // models/entry/get.js and entries handlePaginationAndCallback.
    // Uncacheable still hands the (possibly empty) result back without
    // writing it to the cache; refetching a page of size 1 is cheap.
    if (!entries || !entries.length) {
      throw new Uncacheable(prepared);
    }

    return prepared;
  },
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

  const status = {};
  let prepared;
  try {
    prepared = await latestEntryCache.fetch(key, {
      status,
      context: { blogID: req.blog.id, log },
    });
  } catch (e) {
    if (!(e instanceof Uncacheable)) throw e;
    prepared = e.payload;
  }

  if (status.fetch === "hit") log("Retrieved latest entry from cache");

  return projectEntryFields(cloneEntry(prepared.payload), req.retrieve, ALIASES);
}

module.exports = asRetriever(latestEntry);
module.exports._createCacheKey = createCacheKey;
module.exports._clear = function () {
  latestEntryCache.clear();
};
module.exports._stats = cacheStats("latestEntry", latestEntryCache);
