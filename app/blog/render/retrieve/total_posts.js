const { getTotal } = require("../../lib/models");
const asRetriever = require("../../lib/asRetriever");
const LRUCache = require("lru-cache").LRUCache;
const { prepareCacheValue } = require("../../lib/clone");
const cacheStats = require("../../lib/cacheStats");

const totalPostsCache = new LRUCache({
  max: 10000,
  // Values are numbers (a few bytes each); the byte cap is just for
  // consistency with the other retrieve-path caches.
  maxSize: 1 * 1024 * 1024,
  sizeCalculation: (value) => value.size,
  // Without this, an in-flight fetch evicted by LRU/size pressure aborts and
  // every request coalesced onto it rejects with "Error: evicted" instead
  // of getting its count - let the already-running getTotal call finish and
  // hand its result back even if it can't be cached.
  ignoreFetchAbort: true,
  // Coalesce concurrent misses on the same key into one in-flight
  // getTotal call.
  fetchMethod: async (key, staleValue, { context }) => {
    const total = await getTotal(context.blogID);
    return prepareCacheValue(total);
  },
});

function createCacheKey(blog) {
  return JSON.stringify({
    blogID: String(blog && blog.id),
    cacheID: String(blog && blog.cacheID),
  });
}

async function totalPosts(req, res) {
  const key = createCacheKey(req.blog);
  const prepared = await totalPostsCache.fetch(key, {
    context: { blogID: req.blog.id },
  });
  return prepared.payload;
}

module.exports = asRetriever(totalPosts);
module.exports._createCacheKey = createCacheKey;
module.exports._clear = function () {
  totalPostsCache.clear();
};
module.exports._stats = cacheStats("totalPosts", totalPostsCache);
