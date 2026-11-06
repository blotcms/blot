// getCachedTagged(blogID, slugs, options): a page of the entries tagged with
// one or more slugs, cached in this process per blog cacheID, for rendering
// /tagged/:tag pages and a tag-filtered {{#posts}}.
//
// slugs: one slug or a list of them, in the order the tag's names are joined.
// options: ./tagged's (limit, offset, pathPrefix, sortBy, order), and
// options.keep: the heavy fields (html, body, ...) the caller needs; the rest
// are stripped before the page is stored. Every heavy field when left out. A
// stored page only serves calls that keep the same fields.
// options.cacheID: the blog's cacheID, when the caller already has it. Read
// from Redis otherwise (the client-side cache usually answers that locally).
// options.log: req.log, told how the lookup was served (models/cache/fetchCached).
//
// Resolves to ./tagged's result with the page's entries, in the selected
// order: { entries, entryIDs, tag, tagged, prettyTags, slugs, total,
// pagination }, a copy the caller may change. Only for rendering: the cacheID
// can lag a write by the moment it takes to bump, so code that writes back
// what it read (sync, fix, scripts) must use get.
const { cloneDeep, prepareCacheValue } = require("models/cache/clone");
const cacheStats = require("models/cache/stats");
const fetchCached = require("models/cache/fetchCached");
const { Uncacheable } = require("models/cache/uncacheable");
const { createRenderCache, timeClone } = require("models/cache/metrics");
const client = require("models/client");
const blogKey = require("models/blog/key");
const { normalizePathPrefix } = require("helper/pathPrefix");
const { sortEntries } = require("blog/sortOptions");
const { keepFields, stripHeavyFields } = require("models/entries/heavyFields");

const taggedCache = createRenderCache("tagged", {
  max: 1000,
  // Bound by bytes, not just item count: tag pages hold a full page of
  // entries, and a slug-heavy blog paginating through distinct tags can
  // otherwise fill every slot and starve other blogs sharing this process.
  maxSize: 100 * 1024 * 1024,
  sizeCalculation: (value) => value.size,
  // Without this, an in-flight fetch evicted by LRU/size pressure aborts and
  // every request coalesced onto it rejects with "Error: evicted" instead
  // of getting its page - let the already-running tagged/Entry.get pass
  // finish and hand its result back even if it can't be cached.
  ignoreFetchAbort: true,
  // Coalesce concurrent misses on the same key into one in-flight load.
  fetchMethod: async (key, staleValue, { context }) => {
    const { blogID, slugs, query, keep } = context;

    // Required here: models/tags requires this module (and specs spy on
    // tagged)
    const result = await require("models/tags").tagged(blogID, slugs, query);
    const entryIDs = result.entryIDs || [];
    // Required here: models/entry requires models/tags. A failed read is
    // the same as no entries (see below).
    const entries = await require("models/entry")
      .get(blogID, entryIDs)
      .catch(() => []);

    const payload = {
      ...result,
      // tagged paginated in the selected order; re-apply it to the hydrated
      // page so Entry.get's ordering can't drift.
      entries: stripHeavyFields(sortEntries(entries, query), keep),
      entryIDs,
      total: result.total !== undefined ? result.total : entryIDs.length,
    };

    const prepared = prepareCacheValue(payload, {
      preserveEntryInstances: true,
    });

    // Entry.get swallows Redis MGET failures as [] (models/entry/get.js).
    // If we received IDs but no hydrated entries, that is indistinguishable
    // from a total hydration miss - do not persist it, or later requests
    // would serve an empty tagged page until cacheID changes. Uncacheable
    // still hands the (broken) result back to this render and every request
    // coalesced onto it, without writing it to the cache.
    if (entryIDs.length > 0 && entries.length === 0) {
      throw new Uncacheable(prepared);
    }

    return prepared;
  },
});

// Keeps the slugs' order: tagged builds tag/slugs/prettyTags from the
// original sequence, so ?tag=foo&tag=bar and ?tag=bar&tag=foo must not share
// a cache entry.
function slugsKey(slugs) {
  if (Array.isArray(slugs)) return slugs.map((slug) => String(slug));
  return slugs === undefined ? undefined : String(slugs);
}

function createCacheKey(blogID, cacheID, slugs, query, keep) {
  return JSON.stringify({
    blogID: String(blogID),
    cacheID: String(cacheID),
    tags: slugsKey(slugs),
    sortBy: String(query.sortBy),
    order: String(query.order),
    // Key on the same value tagged actually filters by.
    // normalizePathPrefix(undefined) is null and normalizePathPrefix("undefined")
    // is "/undefined", so an unset prefix cannot collide with the literal
    // string "undefined" (or a numeric 1 with the string "1").
    pathPrefix: normalizePathPrefix(query.pathPrefix),
    limit: Number(query.limit),
    offset: Number(query.offset),
    keep: keep.join(","),
  });
}

async function getCachedTagged(blogID, slugs, options = {}) {
  const keep = keepFields(options.keep);
  const query = {
    limit: options.limit,
    offset: options.offset,
    pathPrefix: options.pathPrefix,
    sortBy: options.sortBy,
    order: options.order,
  };
  const cacheID =
    options.cacheID !== undefined
      ? options.cacheID
      : await client.hGet(blogKey.info(blogID), "cacheID");
  const key = createCacheKey(blogID, cacheID, slugs, query, keep);

  let prepared;
  try {
    prepared = await fetchCached(taggedCache, "tagged", options.log, key, {
      context: { blogID, slugs, query, keep },
    });
  } catch (e) {
    if (!(e instanceof Uncacheable)) throw e;
    prepared = e.payload;
  }

  return timeClone(taggedCache, () =>
    cloneDeep(prepared.payload, { preserveEntryInstances: true })
  );
}

module.exports = getCachedTagged;
module.exports._createCacheKey = createCacheKey;
module.exports._clear = function () {
  taggedCache.clear();
};
module.exports._stats = cacheStats("tagged", taggedCache);
