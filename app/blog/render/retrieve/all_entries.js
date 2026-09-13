const getAllCached = require("./helpers/getAllCached");
const projectEntryFields = require("./helpers/projectEntryFields");
const asRetriever = require("../../lib/asRetriever");
const LRUCache = require("lru-cache").LRUCache;
const { cloneDeep, deepFreeze } = require("../../lib/clone");

const ALIASES = ["allEntries", "all_entries"];

// Caches the already-projected entry list, not just the raw catalog from
// getAllCached - a view that only reads url/title/dateStamp never has to
// pay to store (or re-store) every entry's full html/body/summary.
const allEntriesCache = new LRUCache({
  max: 200,
  maxSize: 100 * 1024 * 1024,
  sizeCalculation: (value) => JSON.stringify(value).length,
});

function cloneEntries(value) {
  return cloneDeep(value, { preserveEntryInstances: true });
}

// null means "no projection metadata for this request" (an alias isn't
// referenced, or is referenced without a fields map) - projectEntryFields
// then leaves every field alone, so the cache must be keyed accordingly:
// two requests that both resolve to null share a (fully populated) entry,
// two requests with different resolved field sets never collide.
function fieldsSignature(retrieve) {
  const fields = projectEntryFields.resolveFields(retrieve, ALIASES);
  return fields ? Object.keys(fields).sort().join(",") : null;
}

function createCacheKey(blog, retrieve) {
  return JSON.stringify({
    blogID: String(blog && blog.id),
    cacheID: String(blog && blog.cacheID),
    fields: fieldsSignature(retrieve),
  });
}

async function allEntries(req, res) {
  // Preview renders change on every save and are rarely repeated, so caching
  // them would only thrash the LRU with entries no other request will read.
  const bypassCache = !!req.preview;
  const key = createCacheKey(req.blog, req.retrieve);

  if (!bypassCache && allEntriesCache.has(key)) {
    return cloneEntries(allEntriesCache.get(key));
  }

  const allEntriesList = await getAllCached(req.blog, { bypassCache });

  projectEntryFields(allEntriesList, req.retrieve, ALIASES);

  // Don't cache an empty result: getAllCached already declines to persist a
  // [] catalog, since Entries.getAll also returns [] on a transient Redis
  // failure rather than rejecting - caching that here would look identical
  // to a genuinely empty blog and hide every post until cacheID changes.
  if (!bypassCache && allEntriesList.length > 0) {
    allEntriesCache.set(key, deepFreeze(cloneEntries(allEntriesList)));
  }

  return allEntriesList;
};

module.exports = asRetriever(allEntries);
module.exports._createCacheKey = createCacheKey;
module.exports._clear = function () {
  allEntriesCache.clear();
};
