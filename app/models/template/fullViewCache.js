// Template.getFullView: ./getFullView's response, cached in this process.
//
// This cache is safe because the key includes blog/template/view identity,
// plus blog.cacheID, which changes whenever render-relevant blog data
// changes, and the template's own cacheID, which changes whenever the
// template does (util/cacheID). A blog's cacheID is only bumped for changes
// to the template it has installed, so the template's is what keeps
// previews of its other templates fresh.
//
// await getFullView(blogID, templateID, viewName, [options])
//
// options.blogCacheID / options.templateCacheID: the cacheIDs, when the
// caller already has them (a render does). Each is read from Redis otherwise;
// the client-side cache usually answers that locally.
// options.log: req.log, told how the lookup was served (models/cache/fetchCached).
//
// Resolves with a copy the caller may change.
const { cloneDeep, prepareCacheValue } = require("models/cache/clone");
const cacheStats = require("models/cache/stats");
const fetchCached = require("models/cache/fetchCached");
const { createRenderCache, timeClone } = require("models/cache/metrics");
const client = require("models/client");
const blogKey = require("models/blog/key");
const key = require("./key");

const fullViewCache = createRenderCache("fullView", {
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
  fetchMethod: async (cacheKey, staleValue, { context }) => {
    const { blogID, templateID, viewName } = context;
    // Looked up at call time so specs can spy on it
    const response = await module.exports._build(blogID, templateID, viewName);
    return prepareCacheValue(response);
  },
});

function createCacheKey(
  blogID,
  blogCacheID,
  templateID,
  templateCacheID,
  viewName
) {
  return JSON.stringify({
    blogID: String(blogID),
    cacheID: String(blogCacheID),
    templateID: String(templateID),
    templateCacheID: String(templateCacheID),
    viewName: String(viewName),
  });
}

async function cacheIDs(blogID, templateID, options) {
  const [blogCacheID, templateCacheID] = await Promise.all([
    options.blogCacheID !== undefined
      ? options.blogCacheID
      : client.hGet(blogKey.info(blogID), "cacheID"),
    options.templateCacheID !== undefined
      ? options.templateCacheID
      : client.hGet(key.metadata(templateID), "cacheID"),
  ]);
  return { blogCacheID, templateCacheID };
}

async function getFullView(blogID, templateID, viewName, options) {
  options = options || {};

  const { blogCacheID, templateCacheID } = await cacheIDs(
    blogID,
    templateID,
    options
  );
  const cacheKey = createCacheKey(
    blogID,
    blogCacheID,
    templateID,
    templateCacheID,
    viewName
  );
  const prepared = await fetchCached(
    fullViewCache,
    "view",
    options.log,
    cacheKey,
    {
      context: { blogID, templateID, viewName },
    }
  );
  return timeClone(fullViewCache, () => cloneDeep(prepared.payload));
}

module.exports = getFullView;
module.exports._build = require("./getFullView");
module.exports._createCacheKey = createCacheKey;
module.exports._clear = function () {
  fullViewCache.clear();
};
module.exports._stats = cacheStats("fullView", fullViewCache);
