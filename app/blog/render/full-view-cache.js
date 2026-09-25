const { getFullView } = require("../lib/models");
const { cloneDeep, prepareCacheValue } = require("../lib/clone");
const cacheStats = require("../lib/cacheStats");
const LRUCache = require("lru-cache").LRUCache;

// This cache is safe because the key includes blog/template/view identity,
// plus blog.cacheID which changes whenever render-relevant blog data changes.
const fullViewCache = new LRUCache({
  max: 1000,
  // Bound by bytes too: unbounded-size views (large templates/partials)
  // shouldn't be able to fill the cache's memory budget on their own.
  maxSize: 20 * 1024 * 1024,
  sizeCalculation: (value) => value.size,
  // Without this, an in-flight fetch evicted by LRU/size pressure aborts and
  // every request coalesced onto it rejects with "Error: evicted" instead
  // of getting its view - let the already-running getFullView call finish
  // and hand its result back even if it can't be cached.
  ignoreFetchAbort: true,
  // Coalesce concurrent misses on the same key into one in-flight
  // getFullView call, rather than one per simultaneous request for the
  // same blog/template/view.
  fetchMethod: async (key, staleValue, { context }) => {
    const { blogID, templateID, viewName } = context;
    const response = await getFullView(blogID, templateID, viewName);
    return prepareCacheValue(response);
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

  const prepared = await fullViewCache.fetch(key, {
    context: { blogID: blog.id, templateID: template.id, viewName },
  });

  return cloneDeep(prepared.payload);
}

module.exports = getCachedFullView;
module.exports._createCacheKey = createCacheKey;
module.exports._clear = function () {
  fullViewCache.clear();
};
module.exports._stats = cacheStats("fullView", fullViewCache);
