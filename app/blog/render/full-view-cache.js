const { getFullView } = require("../lib/models");
const { cloneDeep, deepFreeze } = require("../lib/clone");
const LRUCache = require("lru-cache").LRUCache;

// This cache is safe because the key includes blog/template/view identity,
// plus blog.cacheID which changes whenever render-relevant blog data changes.
const fullViewCache = new LRUCache({
  max: 1000,
  // Bound by bytes too: unbounded-size views (large templates/partials)
  // shouldn't be able to fill the cache's memory budget on their own.
  maxSize: 20 * 1024 * 1024,
  sizeCalculation: function (value) {
    return JSON.stringify(value).length;
  },
});

function createCacheKey(blog, template, viewName) {
  const blogID = blog && blog.id;
  const cacheID = blog && blog.cacheID;
  const templateID = template && template.id;

  return JSON.stringify({
    blogID: String(blogID),
    cacheID: String(cacheID),
    templateID: String(templateID),
    viewName: String(viewName),
  });
}

async function getCachedFullView(options) {
  const blog = options.blog;
  const template = options.template;
  const viewName = options.viewName;

  const key = createCacheKey(blog, template, viewName);

  if (fullViewCache.has(key)) {
    return cloneDeep(fullViewCache.get(key));
  }

  const response = await getFullView(blog.id, template.id, viewName);

  const immutableCopy = deepFreeze(cloneDeep(response));
  fullViewCache.set(key, immutableCopy);

  return cloneDeep(immutableCopy);
}

module.exports = getCachedFullView;
module.exports._createCacheKey = createCacheKey;
module.exports._clear = function () {
  fullViewCache.clear();
};
