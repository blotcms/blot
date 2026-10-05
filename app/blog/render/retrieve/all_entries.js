const getAllCached = require("./helpers/getAllCached");
const projectEntryFields = require("./helpers/projectEntryFields");
const asRetriever = require("../../lib/asRetriever");
const LRUCache = require("lru-cache").LRUCache;
const { prepareCacheValue } = require("../../lib/clone");
const cacheStats = require("../../lib/cacheStats");
const { Uncacheable } = require("../../lib/uncacheableFetch");
const {
  augmentContext,
  augmentEntries,
  shareEntries,
  warnIfTooLargeToCache,
} = require("../load/augmentedEntries");

const ALIASES = ["allEntries", "all_entries"];

// Caches the already-projected, already-augmented entry list, not just the
// raw catalog from getAllCached - a view that only reads url/title/dateStamp
// never has to pay to store (or re-store) every entry's full html/body/
// summary, and a hit skips both the deep clone and augment() for every entry
// (see render/load/augmentedEntries.js).
const allEntriesCache = new LRUCache({
  max: 200,
  maxSize: 100 * 1024 * 1024,
  sizeCalculation: (value) => value.size,
  // See tagged.js: let an in-flight fill evicted under size pressure still
  // hand its result to every request coalesced onto it.
  ignoreFetchAbort: true,
  // Coalesce concurrent misses on the same key into one fill, so a burst of
  // renders after a cacheID change augments the catalog once, not per request.
  fetchMethod: async (key, staleValue, { context }) => {
    const { req, res } = context;
    const allEntriesList = await getAllCached(req.blog);

    projectEntryFields(allEntriesList, req.retrieve, ALIASES);

    // Backlinked entries are trimmed like the list's own.
    const backlinksFailed = await augmentEntries(
      req,
      res,
      allEntriesList,
      (entry) => projectEntryFields(entry, req.retrieve, ALIASES)
    );
    const prepared = prepareCacheValue(allEntriesList, {
      preserveEntryInstances: true,
    });
    warnIfTooLargeToCache("allEntries", req, prepared, allEntriesCache);

    // Don't cache an empty result: getAllCached already declines to persist
    // a [] catalog, since Entries.getAll also returns [] on a transient Redis
    // failure rather than rejecting - caching that here would look identical
    // to a genuinely empty blog and hide every post until cacheID changes.
    if (allEntriesList.length === 0 || backlinksFailed) {
      throw new Uncacheable(prepared);
    }

    return prepared;
  },
});

// null means "no projection metadata for this request" (an alias isn't
// referenced, or is referenced without a fields map) - projectEntryFields
// then leaves every field alone, so the cache must be keyed accordingly:
// two requests that both resolve to null share a (fully populated) entry,
// two requests with different resolved field sets never collide.
function fieldsSignature(retrieve) {
  const fields = projectEntryFields.resolveFields(retrieve, ALIASES);
  return fields ? Object.keys(fields).sort().join(",") : null;
}

function createCacheKey(blog, retrieve, context) {
  return JSON.stringify({
    blogID: String(blog && blog.id),
    cacheID: String(blog && blog.cacheID),
    fields: fieldsSignature(retrieve),
    augment: context,
  });
}

function blogURL(req) {
  return (req.blog && req.blog.locals && req.blog.locals.blogURL) || "";
}

async function allEntries(req, res) {
  // Preview renders change on every save and are rarely repeated, so caching
  // them would only thrash the LRU with entries no other request will read.
  // render/load augments these the usual way.
  if (req.preview) {
    const allEntriesList = await getAllCached(req.blog, { bypassCache: true });
    projectEntryFields(allEntriesList, req.retrieve, ALIASES);
    return allEntriesList;
  }

  const key = createCacheKey(req.blog, req.retrieve, augmentContext(req, res));

  let prepared;
  try {
    prepared = await allEntriesCache.fetch(key, { context: { req, res } });
  } catch (e) {
    if (!(e instanceof Uncacheable)) throw e;
    prepared = e.payload;
  }

  return shareEntries(prepared.payload, blogURL(req));
}

module.exports = asRetriever(allEntries);
module.exports._createCacheKey = createCacheKey;
module.exports._clear = function () {
  allEntriesCache.clear();
};
module.exports._stats = cacheStats("allEntries", allEntriesCache);
