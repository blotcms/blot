// getCachedPage(blogID, options): getPage's page of entries, cached in this
// process per blog cacheID, so a burst of renders of the same page (and every
// page of a blog whose navigation lists {{#posts}}) reads it from Redis once
// per cacheID instead of once each.
//
// options: getPage's (pageNumber, pageSize, sortBy, order, pathPrefix), and
// options.keep: the heavy fields (html, body, ...) the caller needs; the rest
// are stripped before the page is stored, so a view that lists titles doesn't
// keep each entry's full HTML in memory, nor copy it on every hit. Every
// heavy field when left out. Unlike getCatalog, a stored page only serves
// calls that keep the same fields: a page is small next to a catalog.
// options.cacheID: the blog's cacheID, when the caller already has it. Read
// from Redis otherwise (the client-side cache usually answers that locally).
// options.log: req.log, told how the lookup was served (models/cache/fetchCached).
//
// Resolves to { entries, pagination }, a copy the caller may change, or
// rejects as getPage does (a 400 for an invalid page number). Only for
// rendering: the cacheID can lag a write by the moment it takes to bump, so
// code that writes back what it read (sync, fix, scripts) must use getPage.
const { cloneDeep, prepareCacheValue } = require("models/cache/clone");
const cacheStats = require("models/cache/stats");
const fetchCached = require("models/cache/fetchCached");
const { createRenderCache, timeClone } = require("models/cache/metrics");
const client = require("models/client");
const blogKey = require("models/blog/key");
const { normalizePathPrefix } = require("helper/pathPrefix");
const { keepFields, stripHeavyFields } = require("./heavyFields");

const postsCache = createRenderCache("posts", {
  max: 1000,
  // Bound by bytes, not just item count: a blog paginating through hundreds
  // of pages (up to 100 entries each) can otherwise fill all 1000 slots with
  // large payloads and starve every other blog sharing this process's memory.
  maxSize: 100 * 1024 * 1024,
  sizeCalculation: (value) => value.size,
  // Without this, an in-flight fetch that gets evicted by LRU/size pressure
  // (busy process, byte-capped cache) aborts and every request coalesced
  // onto it rejects with "Error: evicted" - a 500 - instead of getting the
  // page it asked for. ignoreFetchAbort lets the already-running getPage
  // call finish and hand its result to those callers; it just won't be
  // re-inserted into the (already full) cache.
  ignoreFetchAbort: true,
  // Concurrent misses on the same key share a single in-flight getPage - e.g.
  // a burst of near-simultaneous requests (a page full of broken <img> tags
  // all 404ing at once) that all miss the same cold page.
  fetchMethod: async (key, staleValue, { context }) => {
    const { blogID, query, keep } = context;
    const page = await new Promise((resolve, reject) => {
      // Required here: models/entries requires this module (and specs spy
      // on getPage)
      require("models/entries").getPage(
        blogID,
        query,
        (err, entries, pagination) => {
          if (err) reject(err);
          else resolve({ entries, pagination });
        }
      );
    });
    stripHeavyFields(page.entries || [], keep);
    return prepareCacheValue(page, { preserveEntryInstances: true });
  },
});

// getPage validates pageNumber and pageSize itself (a 400 for a non-digit
// page, a default page size of 5), so the key holds them as given: a page
// size left unset must not share a key with any explicit one (#1844).
function optional(value) {
  return value === undefined ? undefined : String(value);
}

function createCacheKey(blogID, cacheID, query, keep) {
  return JSON.stringify({
    blogID: String(blogID),
    cacheID: String(cacheID),
    pageNumber: optional(query.pageNumber),
    pageSize: optional(query.pageSize),
    sortBy: optional(query.sortBy),
    order: optional(query.order),
    // The value getPage filters by, so "1" (a prefix) and 1 (ignored) differ
    pathPrefix: normalizePathPrefix(query.pathPrefix),
    keep: keep.join(","),
  });
}

async function getCachedPage(blogID, options = {}) {
  const keep = keepFields(options.keep);
  const query = {
    pageNumber: options.pageNumber,
    pageSize: options.pageSize,
    sortBy: options.sortBy,
    order: options.order,
    pathPrefix: options.pathPrefix,
  };
  const cacheID =
    options.cacheID !== undefined
      ? options.cacheID
      : await client.hGet(blogKey.info(blogID), "cacheID");
  const key = createCacheKey(blogID, cacheID, query, keep);

  const prepared = await fetchCached(postsCache, "posts", options.log, key, {
    context: { blogID, query, keep },
  });

  return timeClone(postsCache, () =>
    cloneDeep(prepared.payload, { preserveEntryInstances: true })
  );
}

module.exports = getCachedPage;
module.exports._createCacheKey = createCacheKey;
module.exports._clear = function () {
  postsCache.clear();
};
module.exports._stats = cacheStats("posts", postsCache);
