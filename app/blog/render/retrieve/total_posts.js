const { getTotal } = require("../../lib/models");
const asRetriever = require("../../lib/asRetriever");
const LRUCache = require("lru-cache").LRUCache;

const totalPostsCache = new LRUCache({
  max: 10000,
  // Values are numbers (a few bytes each); the byte cap is just for
  // consistency with the other retrieve-path caches.
  maxSize: 1 * 1024 * 1024,
  sizeCalculation: (value) => JSON.stringify(value).length,
});

function createCacheKey(blog) {
  return JSON.stringify({
    blogID: String(blog && blog.id),
    cacheID: String(blog && blog.cacheID),
  });
}

async function totalPosts(req, res) {
  const key = createCacheKey(req.blog);

  if (totalPostsCache.has(key)) {
    return totalPostsCache.get(key);
  }

  const total = await getTotal(req.blog.id);
  totalPostsCache.set(key, total);
  return total;
}

module.exports = asRetriever(totalPosts);
module.exports._createCacheKey = createCacheKey;
module.exports._clear = function () {
  totalPostsCache.clear();
};
