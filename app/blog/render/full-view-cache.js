var Template = require("models/template");
var LRUCache = require("lru-cache").LRUCache;

// This cache is safe because the key includes blog/template/view identity,
// plus blog.cacheID which changes whenever render-relevant blog data changes.
var fullViewCache = new LRUCache({
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

function createCacheKey(blog, template, viewName) {
  var blogID = blog && blog.id;
  var cacheID = blog && blog.cacheID;
  var templateID = template && template.id;

  return JSON.stringify({
    blogID: String(blogID),
    cacheID: String(cacheID),
    templateID: String(templateID),
    viewName: String(viewName),
  });
}

module.exports = function getCachedFullView(options, callback) {
  var blog = options.blog;
  var template = options.template;
  var viewName = options.viewName;

  var key = createCacheKey(blog, template, viewName);

  if (fullViewCache.has(key)) {
    return callback(null, cloneDeep(fullViewCache.get(key)));
  }

  Template.getFullView(blog.id, template.id, viewName, function (err, response) {
    if (err) {
      return callback(err);
    }

    var immutableCopy = deepFreeze(cloneDeep(response));

    fullViewCache.set(key, immutableCopy);

    return callback(null, cloneDeep(immutableCopy));
  });
};

module.exports._createCacheKey = createCacheKey;
module.exports._clear = function () {
  fullViewCache.clear();
};
