const { getEntry } = require("../../lib/models");
const fetchTaggedEntries = require("./helpers/fetchTaggedEntries");
const projectEntryFields = require("./helpers/projectEntryFields");
const asRetriever = require("../../lib/asRetriever");
const { cloneDeep, prepareCacheValue } = require("../../lib/clone");
const cacheStats = require("../../lib/cacheStats");
const { Uncacheable } = require("../../lib/uncacheableFetch");
const LRUCache = require("lru-cache").LRUCache;
const { normalizePathPrefix } = require("helper/pathPrefix");
const {
  normalizePageNumber,
  normalizePageSize,
} = require("../../lib/pagination");
const getTemplateSortOptions = require("blog/sortOptions");
const { sortEntries } = getTemplateSortOptions;

// Separate from posts.js's tagged branch: that cache stores {entries,
// pagination} keyed on page_size, while this local stores the full tagged
// payload (tag metadata, slugs, prettyTags, totals) keyed on
// tagged_page_size || page_size. Official /tagged/:tag pages never go
// through posts.js, so sharing storage would still miss this path and
// would collide on the different payload shape.
const taggedCache = new LRUCache({
  max: 1000,
  // Bound by bytes, not just item count: official /tagged/:tag pages
  // return a full page of entries, and a slug-heavy blog paginating
  // through distinct tags can otherwise fill every slot and starve
  // other blogs sharing this process.
  maxSize: 100 * 1024 * 1024,
  sizeCalculation: (value) => value.size,
  // Without this, an in-flight fetch evicted by LRU/size pressure aborts and
  // every request coalesced onto it rejects with "Error: evicted" instead
  // of getting its page - let the already-running fetchTaggedEntries/
  // Entry.get pass finish and hand its result back even if it can't be
  // cached.
  ignoreFetchAbort: true,
  // Coalesce concurrent misses on the same key into one in-flight load.
  fetchMethod: async (key, staleValue, { context }) => {
    const { blogID, tags, limit, offset, pathPrefix, sortOptions } = context;

    const result = await fetchTaggedEntries(blogID, tags, {
      limit,
      offset,
      pathPrefix,
      ...sortOptions,
    });

    const entryIDs = result.entryIDs || [];
    let entries = await getEntry(blogID, entryIDs);
    entries = sortEntries(entries, sortOptions);

    const totalEntries =
      result.total !== undefined ? result.total : entryIDs.length;

    const payload = {
      tag: result.tag,
      tagged: result.tagged,
      is: result.tagged, // alias
      entries,
      pagination: result.pagination,
      total: totalEntries,
      entryIDs,
      slugs: result.slugs,
      prettyTags: result.prettyTags,
    };

    const prepared = prepareCacheValue(payload, { preserveEntryInstances: true });

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

function cloneTagged(value) {
  return cloneDeep(value, { preserveEntryInstances: true });
}

function normalizeTagsKey(tags) {
  // Preserve array order: fetchTaggedEntries builds tag/slugs/prettyTags
  // from the original sequence, so ?tag=foo&tag=bar and ?tag=bar&tag=foo
  // must not share a cache entry.
  if (Array.isArray(tags)) return tags.map((tag) => String(tag));
  return tags === undefined ? undefined : String(tags);
}

function createCacheKey(req, normalized) {
  return JSON.stringify({
    blogID: String(req?.blog?.id),
    cacheID: String(req?.blog?.cacheID),
    tags: normalized.tags,
    sortBy: String(normalized.sortBy),
    order: String(normalized.order),
    // Key on the same value fetchTaggedEntries actually filters by.
    // normalizePathPrefix(undefined) is null and normalizePathPrefix("undefined")
    // is "/undefined", so an unset prefix cannot collide with the literal
    // string "undefined" (or a numeric 1 with the string "1").
    pathPrefix: normalizePathPrefix(normalized.pathPrefix),
    page: Number(normalized.page),
    limit: Number(normalized.limit),
  });
}

async function tagged(req, res) {
  const log = typeof req?.log === "function" ? req.log.bind(req) : () => {};
  const blogID = req.blog.id;
  const tags =
    req.query.name ||
    req.query.tag ||
    req.params.tag ||
    (res.locals && res.locals.tag) ||
    "";

  const page = normalizePageNumber(req.params.page);

  const templateLocals = (req.template && req.template.locals) || {};
  const pathPrefix =
    (res.locals && res.locals.path_prefix) ?? templateLocals.path_prefix;
  const sortOptions = getTemplateSortOptions(templateLocals);

  const preferredLimit =
    templateLocals.tagged_page_size !== undefined
      ? templateLocals.tagged_page_size
      : templateLocals.page_size;

  const limit = normalizePageSize(preferredLimit);
  const offset = (page - 1) * limit;

  const key = createCacheKey(req, {
    tags: normalizeTagsKey(tags),
    sortBy: sortOptions.sortBy,
    order: sortOptions.order,
    pathPrefix,
    page,
    limit,
  });

  const status = {};
  let prepared;
  try {
    prepared = await taggedCache.fetch(key, {
      status,
      context: { blogID, tags, limit, offset, pathPrefix, sortOptions },
    });
  } catch (e) {
    if (!(e instanceof Uncacheable)) throw e;
    prepared = e.payload;
  }

  if (status.fetch === "hit") log("Retrieved tagged entries from cache");

  const payload = cloneTagged(prepared.payload);

  res.locals.pagination = res.locals.pagination || payload.pagination || {};

  // Clone before projecting so the LRU payload is not mutated in place.
  // Preserve Entry prototypes so render-time augmentation
  // (date/formatDate/absoluteURL/tags helpers) still applies -
  // see render/load/eachEntry.js.
  const entries = cloneDeep(payload.entries, { preserveEntryInstances: true });
  projectEntryFields(entries, req.retrieve, ["tagged", "entries"]);

  return { ...payload, entries };
}

module.exports = asRetriever(tagged);
module.exports._createCacheKey = createCacheKey;
module.exports._clear = function () {
  taggedCache.clear();
};
module.exports._stats = cacheStats("tagged", taggedCache);
