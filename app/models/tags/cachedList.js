// getCachedList(blogID, options): list's tags, cached in this process per
// blog cacheID, for rendering.
//
// options.pathPrefix: as for list.
// options.cacheID: the blog's cacheID, when the caller already has it. Read
// from Redis otherwise (the client-side cache usually answers that locally).
// options.log: req.log, told how the lookup was served (models/cache/fetchCached).
//
// Resolves to a copy the caller may change. Only for rendering: the cacheID
// can lag a write by the moment it takes to bump, so code that writes back
// what it read (sync, fix, scripts) must use list.
const { cloneDeep, prepareCacheValue } = require("models/cache/clone");
const cacheStats = require("models/cache/stats");
const fetchCached = require("models/cache/fetchCached");
const { createRenderCache } = require("models/cache/metrics");
const client = require("models/client");
const blogKey = require("models/blog/key");
const { normalizePathPrefix } = require("helper/pathPrefix");
const { compactTags, expandTags } = require("./compact");

// Tag entries are IDs (or nulls without a path prefix, which compactTags
// stores as a count), never entry bodies, so the whole list is cached as-is.
const allTagsCache = createRenderCache("allTags", {
  max: 1000,
  maxSize: 50 * 1024 * 1024,
  sizeCalculation: (value) => value.size,
  // Without this, an in-flight fetch evicted by LRU/size pressure aborts and
  // every request coalesced onto it rejects with "Error: evicted" instead
  // of getting its tags - let the already-running list call finish and hand
  // its result back even if it can't be cached.
  ignoreFetchAbort: true,
  // Coalesce concurrent misses on the same key into one in-flight list call.
  fetchMethod: async (key, staleValue, { context }) => {
    const { blogID, pathPrefix } = context;
    const tags = await new Promise((resolve, reject) => {
      // Required here: models/tags requires this module (and specs spy on
      // list)
      require("models/tags").list(
        blogID,
        { path_prefix: pathPrefix },
        (err, tags) => {
          if (err) reject(err);
          else resolve(tags);
        }
      );
    });
    return prepareCacheValue(compactTags(tags));
  },
});

function createCacheKey(blogID, cacheID, pathPrefix) {
  return JSON.stringify({
    blogID: String(blogID),
    cacheID: String(cacheID),
    // Key on the same normalized value list filters by, not the raw
    // pathPrefix - list treats a non-string as "no filter" and normalizes
    // "1" into "/1", so a naive String() key would collide "1" (a real
    // prefix) with 1 (ignored) and serve one view's tag set to the other.
    pathPrefix: normalizePathPrefix(pathPrefix),
  });
}

async function getCachedList(blogID, options = {}) {
  const cacheID =
    options.cacheID !== undefined
      ? options.cacheID
      : await client.hGet(blogKey.info(blogID), "cacheID");
  const key = createCacheKey(blogID, cacheID, options.pathPrefix);

  const prepared = await fetchCached(
    allTagsCache,
    "allTags",
    options.log,
    key,
    {
      context: { blogID, pathPrefix: options.pathPrefix },
    }
  );

  return expandTags(cloneDeep(prepared.payload));
}

module.exports = getCachedList;
module.exports._createCacheKey = createCacheKey;
module.exports._clear = function () {
  allTagsCache.clear();
};
module.exports._stats = cacheStats("allTags", allTagsCache);
