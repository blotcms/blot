var Tags = require("models/tags");
var LRUCache = require("lru-cache").LRUCache;

// Safe cache key includes blog/cache identity and query pagination options.
var popularTagsCache = new LRUCache({
  max: 1000,
});

function cloneDeep(value) {
  if (Array.isArray(value)) {
    return value.map(cloneDeep);
  }

  if (value && typeof value === "object") {
    var clone = {};

    Object.keys(value).forEach(function (key) {
      clone[key] = cloneDeep(value[key]);
    });

    return clone;
  }

  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  Object.keys(value).forEach(function (key) {
    deepFreeze(value[key]);
  });

  return Object.freeze(value);
}

function createCacheKey(blog, options) {
  var blogID = blog && blog.id;
  var cacheID = blog && blog.cacheID;
  var limit = options && options.limit;
  var offset = options && options.offset;

  return JSON.stringify({
    blogID: String(blogID),
    cacheID: String(cacheID),
    limit: Number(limit),
    offset: Number(offset),
  });
}

module.exports = function (req, res, callback) {
  req.log("Listing popular tags");

  // We could make this limit configurable through req.query or config
  var options = { limit: 100, offset: 0 };
  var key = createCacheKey(req.blog, options);

  if (popularTagsCache.has(key)) {
    req.log("Retrieved popular tags from cache");

    return callback(null, cloneDeep(popularTagsCache.get(key)));
  }

  Tags.popular(req.blog.id, options, function (err, tags) {
    if (err) {
      return callback(err);
    }

    // Map to match expected format
    req.log('Formatting popular tags');
    tags = tags.map((tag) => ({
      name: tag.name,
      tag: tag.name, // for backward compatibility
      entries: tag.entries,
      total: tag.count,
      slug: encodeURIComponent(tag.slug)
    }));

    var immutableCopy = deepFreeze(cloneDeep(tags));

    popularTagsCache.set(key, immutableCopy);

    req.log("Listed popular tags");
    return callback(null, cloneDeep(immutableCopy));
  });
};

module.exports._createCacheKey = createCacheKey;
module.exports._clear = function () {
  popularTagsCache.clear();
};
