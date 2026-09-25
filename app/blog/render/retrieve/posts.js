const { getEntry, getPage } = require("../../lib/models");
const LRUCache = require("lru-cache").LRUCache;
const fetchTaggedEntries = require("./helpers/fetchTaggedEntries");
const projectEntryFields = require("./helpers/projectEntryFields");
const getTemplateSortOptions = require("blog/sortOptions");
const { cloneDeep, prepareCacheValue } = require("../../lib/clone");
const cacheStats = require("../../lib/cacheStats");
const asRetriever = require("../../lib/asRetriever");
const {
  normalizePageNumber,
  normalizePageSize,
} = require("../../lib/pagination");
const { sortEntries } = getTemplateSortOptions;

const postsCache = new LRUCache({
  max: 1000,
  // Bound by bytes, not just item count: a single tag-heavy blog paginating
  // through hundreds of distinct tags can otherwise fill all 1000 slots with
  // large payloads (up to 500 full entries each) and starve every other
  // blog sharing this process's memory.
  maxSize: 100 * 1024 * 1024,
  sizeCalculation: (value) => value.size,
  // Without this, an in-flight fetch that gets evicted by LRU/size pressure
  // (busy process, byte-capped cache) aborts and every request coalesced
  // onto it rejects with "Error: evicted" - a 500 - instead of getting the
  // page it asked for. ignoreFetchAbort lets the already-running getPage/
  // fetchTaggedEntries call finish and hand its result to those callers; it
  // just won't be re-inserted into the (already full) cache.
  ignoreFetchAbort: true,
  // fetchMethod makes concurrent misses on the same key share a single
  // in-flight load instead of each request fetching independently - e.g. a
  // burst of near-simultaneous requests (a page full of broken <img> tags
  // all 404ing at once) that all miss the same cold page of posts would
  // otherwise each hit Redis/Mongo for the same data.
  fetchMethod: async (key, staleValue, { context }) => {
    const { blogID, tags, options, offset, pageSize, req, log } = context;

    let payload;

    if (!tags) {
      log("Loading page of entries");
      // Forward the raw, unnormalized pageNumber/pageSize here: models/entries
      // getPage does its own validation (default page size 5, max 100, and a
      // 400 for a non-digit :page) which bots probe for. lib/pagination's
      // normalizePageNumber/normalizePageSize (used for pagination math and
      // the tagged branch) have different defaults (100/500) and never
      // reject, so they're only used for the tagged branch and the cache
      // key - never as an override here.
      const page = await getPage(blogID, options);
      payload = { entries: page.entries, pagination: page.pagination };
    } else {
      log("Loading tagged page of entries");
      const result = await fetchTaggedEntries(blogID, tags, {
        limit: pageSize,
        offset,
        pathPrefix: options.pathPrefix,
        sortBy: options.sortBy,
        order: options.order,
      });

      const entries = await getEntry(blogID, result.entryIDs || []);
      payload = {
        // fetchTaggedEntries paginated in the selected order; re-apply it to
        // the hydrated page so Entry.get's ordering can't drift.
        entries: sortEntries(entries, options),
        pagination: result.pagination || {},
      };
    }

    // Resolve/project before insertion so large unrequested bodies never
    // enter the LRU. A null field signature deliberately preserves the full
    // variant.
    projectEntryFields(payload.entries, req.retrieve, ["posts", "entries"]);
    return prepareCacheValue(payload, { preserveEntryInstances: true });
  },
});

function clonePosts(value) {
  return cloneDeep(value, { preserveEntryInstances: true });
}

function normalizeTagKey(tags) {
  if (Array.isArray(tags)) {
    return tags.map((tag) => String(tag)).sort();
  }

  return tags === undefined ? undefined : String(tags);
}

function fieldsSignature(retrieve) {
  // Include `entries` so a listing view that also binds {{#entries}}
  // (whose fields parseTemplate does not record on `posts`) shares the
  // unprojected cache variant rather than a title-only one.
  const fields = projectEntryFields.resolveFields(retrieve, ["posts", "entries"]);
  return fields ? Object.keys(fields).sort().join(",") : null;
}

function createCacheKey(req, res, normalizedOptions) {
  return JSON.stringify({
    blogID: String(req?.blog?.id),
    cacheID: String(req?.blog?.cacheID),
    branch: String(normalizedOptions.branch),
    tags: normalizeTagKey(normalizedOptions.tags),
    sortBy: String(normalizedOptions.sortBy),
    order: String(normalizedOptions.order),
    // String(undefined) === "undefined", which would collide with an
    // actual path_prefix of the literal string "undefined". Leave it as
    // undefined (JSON.stringify omits the property) instead of collapsing
    // both to the same key.
    pathPrefix:
      normalizedOptions.pathPrefix === undefined
        ? undefined
        : String(normalizedOptions.pathPrefix),
    pageNumber: Number(normalizedOptions.pageNumber),
    pageSize: Number(normalizedOptions.pageSize),
    limit: Number(normalizedOptions.limit),
    offset: Number(normalizedOptions.offset),
    fields: fieldsSignature(req && req.retrieve),
  });
}

async function posts(req, res) {
  const blogID = req?.blog?.id;
  const log = typeof req?.log === "function" ? req.log.bind(req) : () => {};

  const sortOptions = getTemplateSortOptions(req?.template?.locals);

  const options = {
    sortBy: sortOptions.sortBy,
    order: sortOptions.order,
    pageNumber: req?.params?.page ?? req?.query?.page,
    pageSize: res.locals?.page_size ?? req?.template?.locals?.page_size,
    pathPrefix: res.locals?.path_prefix ?? req?.template?.locals?.path_prefix,
  };

  const tags = req?.query?.tag || req?.params?.tag || res?.locals?.tag;
  const pageNumber = normalizePageNumber(options.pageNumber);
  const pageSize = normalizePageSize(options.pageSize);
  const offset = (pageNumber - 1) * pageSize;
  const normalizedOptions = {
    branch: tags ? "tagged" : "untagged",
    tags,
    sortBy: options.sortBy,
    order: options.order,
    pathPrefix: options.pathPrefix,
    pageNumber,
    // The untagged branch forwards the RAW, unnormalized options.pageSize
    // to getPage below - models/entries defaults an unset value to 5,
    // while normalizePageSize's own default (used for pagination math and
    // the tagged branch) is 100. Keying on the normalized value here would
    // make an unset page_size collide with an explicit page_size of 100,
    // silently serving whichever request populated the cache first to the
    // other - see https://github.com/blotcms/blot/issues/1844. The
    // tagged branch always fetches with the normalized `limit` below, so
    // its key uses that same normalized value.
    pageSize: tags ? pageSize : options.pageSize,
    limit: pageSize,
    offset,
  };

  const key = createCacheKey(req, res, normalizedOptions);
  const status = {};
  const prepared = await postsCache.fetch(key, {
    status,
    context: { blogID, tags, options, offset, pageSize, req, log },
  });

  if (status.fetch === "hit") log("Retrieved posts from cache");

  const responsePayload = clonePosts(prepared.payload);

  res.locals.pagination = responsePayload.pagination;
  return responsePayload.entries;
}

module.exports = asRetriever(posts);
module.exports._createCacheKey = createCacheKey;
module.exports._clear = function () {
  postsCache.clear();
};
module.exports._stats = cacheStats("posts", postsCache);
