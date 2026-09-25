const { popularTags: getPopularTags } = require("../../lib/models");
const { cloneDeep, prepareCacheValue } = require("../../lib/clone");
const cacheStats = require("../../lib/cacheStats");
const { compactTags, expandTags } = require("./helpers/compactTags");
const LRUCache = require("lru-cache").LRUCache;
const asRetriever = require("../../lib/asRetriever");

// Safe cache key includes blog/cache identity and query pagination options.
const popularTagsCache = new LRUCache({
  max: 1000,
  // Bound by bytes too, for consistency with the other render-path caches.
  maxSize: 5 * 1024 * 1024,
  sizeCalculation: (value) => value.size,
  // Without this, an in-flight fetch evicted by LRU/size pressure aborts and
  // every request coalesced onto it rejects with "Error: evicted" instead
  // of getting its tags - let the already-running getPopularTags call
  // finish and hand its result back even if it can't be cached.
  ignoreFetchAbort: true,
  // Coalesce concurrent misses on the same key into one in-flight
  // getPopularTags call, rather than one per simultaneous request.
  fetchMethod: async (key, staleValue, { context }) => {
    const { blogID, options, log } = context;

    let tags = await getPopularTags(blogID, options);

    log("Formatting popular tags");
    tags = tags.map((tag) => ({
      name: tag.name,
      tag: tag.name, // for backward compatibility
      entries: tag.entries,
      total: tag.count,
      slug: encodeURIComponent(tag.slug),
    }));

    log("Listed popular tags");
    return prepareCacheValue(compactTags(tags));
  },
});

function createCacheKey(blog, options) {
  const blogID = blog && blog.id;
  const cacheID = blog && blog.cacheID;
  const limit = options && options.limit;
  const offset = options && options.offset;

  return JSON.stringify({
    blogID: String(blogID),
    cacheID: String(cacheID),
    limit: Number(limit),
    offset: Number(offset),
  });
}

async function popularTags(req, res) {
  req.log("Listing popular tags");

  // We could make this limit configurable through req.query or config
  const options = { limit: 100, offset: 0 };
  const key = createCacheKey(req.blog, options);

  const status = {};
  const prepared = await popularTagsCache.fetch(key, {
    status,
    context: { blogID: req.blog.id, options, log: req.log },
  });

  if (status.fetch === "hit") req.log("Retrieved popular tags from cache");

  return expandTags(cloneDeep(prepared.payload));
}

module.exports = asRetriever(popularTags);
module.exports._createCacheKey = createCacheKey;
module.exports._clear = function () {
  popularTagsCache.clear();
};
module.exports._stats = cacheStats("popularTags", popularTagsCache);
