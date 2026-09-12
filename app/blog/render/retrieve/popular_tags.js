const { popularTags: getPopularTags } = require("../../lib/models");
const { cloneDeep, deepFreeze } = require("../../lib/clone");
const LRUCache = require("lru-cache").LRUCache;
const asRetriever = require("../../lib/asRetriever");

// Safe cache key includes blog/cache identity and query pagination options.
const popularTagsCache = new LRUCache({
  max: 1000,
  // Bound by bytes too, for consistency with the other render-path caches.
  maxSize: 5 * 1024 * 1024,
  sizeCalculation: function (value) {
    return JSON.stringify(value).length;
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

  if (popularTagsCache.has(key)) {
    req.log("Retrieved popular tags from cache");
    return cloneDeep(popularTagsCache.get(key));
  }

  let tags = await getPopularTags(req.blog.id, options);

  // Map to match expected format
  req.log("Formatting popular tags");
  tags = tags.map((tag) => ({
    name: tag.name,
    tag: tag.name, // for backward compatibility
    entries: tag.entries,
    total: tag.count,
    slug: encodeURIComponent(tag.slug),
  }));

  const immutableCopy = deepFreeze(cloneDeep(tags));
  popularTagsCache.set(key, immutableCopy);

  req.log("Listed popular tags");
  return cloneDeep(immutableCopy);
};

module.exports = asRetriever(popularTags);
module.exports._createCacheKey = createCacheKey;
module.exports._clear = function () {
  popularTagsCache.clear();
};
