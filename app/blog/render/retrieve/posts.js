const { getEntry, getPage } = require("../../lib/models");
const LRUCache = require("lru-cache").LRUCache;
const fetchTaggedEntries = require("./helpers/fetchTaggedEntries");
const projectEntryFields = require("./helpers/projectEntryFields");
const getTemplateSortOptions = require("blog/sortOptions");
const { cloneDeep, deepFreeze } = require("../../lib/clone");
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
  sizeCalculation: (value) => JSON.stringify(value).length,
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

function createCacheKey(req, res, normalizedOptions) {
  return JSON.stringify({
    blogID: String(req?.blog?.id),
    cacheID: String(req?.blog?.cacheID),
    branch: String(normalizedOptions.branch),
    tags: normalizeTagKey(normalizedOptions.tags),
    sortBy: String(normalizedOptions.sortBy),
    order: String(normalizedOptions.order),
    pathPrefix: String(normalizedOptions.pathPrefix),
    pageNumber: Number(normalizedOptions.pageNumber),
    pageSize: Number(normalizedOptions.pageSize),
    limit: Number(normalizedOptions.limit),
    offset: Number(normalizedOptions.offset),
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
    pageSize,
    limit: pageSize,
    offset,
  };

  const key = createCacheKey(req, res, normalizedOptions);

  if (postsCache.has(key)) {
    const cachedPayload = clonePosts(postsCache.get(key));
    log("Retrieved posts from cache");
    res.locals.pagination = cachedPayload.pagination;
    return projectEntryFields(cachedPayload.entries, req.retrieve, ["posts"]);
  }

  let payload;

  if (!tags) {
    log("Loading page of entries");
    // Forward the raw, unnormalized pageNumber/pageSize here: models/entries
    // getPage does its own validation (default page size 5, max 100, and a
    // 400 for a non-digit :page) which bots probe for. lib/pagination's
    // normalizePageNumber/normalizePageSize above have different defaults
    // (100/500) and never reject, so they're only used for the tagged
    // branch and the cache key below - never as an override here.
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

  const immutableCopy = deepFreeze(clonePosts(payload));
  postsCache.set(key, immutableCopy);
  const responsePayload = clonePosts(immutableCopy);

  res.locals.pagination = responsePayload.pagination;
  return projectEntryFields(responsePayload.entries, req.retrieve, ["posts"]);
};

module.exports = asRetriever(posts);
module.exports._createCacheKey = createCacheKey;
module.exports._clear = function () {
  postsCache.clear();
};
