const Entry = require("models/entry");
const EntryInstance = require("models/entry/instance");
const entriesModel = require("models/entries");
const LRUCache = require("lru-cache").LRUCache;
const fetchTaggedEntries = require("./helpers/fetchTaggedEntries");

const postsCache = new LRUCache({
  max: 1000,
});

function cloneDeep(value) {
  if (Array.isArray(value)) {
    return value.map(cloneDeep);
  }

  if (value && typeof value === "object") {
    const clone = value instanceof EntryInstance ? new EntryInstance() : {};

    Object.keys(value).forEach((key) => {
      clone[key] = cloneDeep(value[key]);
    });

    return clone;
  }

  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  Object.keys(value).forEach((key) => {
    deepFreeze(value[key]);
  });

  return Object.freeze(value);
}

function normalizeTagKey(tags) {
  if (Array.isArray(tags)) {
    return tags.map((tag) => String(tag)).sort();
  }

  return tags === undefined ? undefined : String(tags);
}

function parsePositiveInteger(value, fallback) {
  const parsed = parseInt(value, 10);

  if (!parsed || parsed < 1) {
    return fallback;
  }

  return parsed;
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

module.exports = function (req, res, callback) {
  const blogID = req?.blog?.id;
  const log = typeof req?.log === "function" ? req.log.bind(req) : () => {};

  const options = {
    sortBy: req?.template?.locals?.sort_by,
    order: req?.template?.locals?.sort_order,
    pageNumber: req?.params?.page ?? req?.query?.page,
    pageSize: res.locals?.page_size ?? req?.template?.locals?.page_size,
    pathPrefix: res.locals?.path_prefix ?? req?.template?.locals?.path_prefix,
  };

  const tags = req?.query?.tag || req?.params?.tag || res?.locals?.tag;
  const normalizedPageNumber = parsePositiveInteger(options.pageNumber, 1);
  const normalizedPageSize = parsePositiveInteger(options.pageSize, 100);
  const normalizedLimit = Math.max(1, Math.min(500, normalizedPageSize));
  const normalizedOffset = (normalizedPageNumber - 1) * normalizedLimit;
  const normalizedOptions = {
    branch: tags ? "tagged" : "untagged",
    tags,
    sortBy: options.sortBy,
    order: options.order,
    pathPrefix: options.pathPrefix,
    pageNumber: normalizedPageNumber,
    pageSize: normalizedPageSize,
    limit: normalizedLimit,
    offset: normalizedOffset,
  };

  const key = createCacheKey(req, res, normalizedOptions);

  if (postsCache.has(key)) {
    const cachedPayload = cloneDeep(postsCache.get(key));
    log("Retrieved posts from cache");
    res.locals.pagination = cachedPayload.pagination;
    return callback(null, cachedPayload.entries);
  }

  if (!tags) {
    log("Loading page of entries");
    return entriesModel.getPage(blogID, options, (err, entries, pagination) => {
      if (err) {
        return callback(err);
      }

      const payload = { entries, pagination };
      const immutableCopy = deepFreeze(cloneDeep(payload));
      postsCache.set(key, immutableCopy);
      const responsePayload = cloneDeep(immutableCopy);

      res.locals.pagination = responsePayload.pagination;

      callback(null, responsePayload.entries);
    });
  }

  let page = parseInt(options.pageNumber, 10);
  if (!page || page < 1) page = 1;

  let limit = parseInt(options.pageSize, 10);
  if (!Number.isFinite(limit)) limit = undefined;
  if (!limit || limit < 1 || limit > 500) limit = 100;

  const offset = (page - 1) * limit;

  log("Loading tagged page of entries");
  fetchTaggedEntries(
    blogID,
    tags,
    { limit, offset, pathPrefix: options.pathPrefix },
    (err, result) => {
      if (err) {
        return callback(err);
      }

      Entry.get(blogID, result.entryIDs || [], (entries) => {
        entries.sort((a, b) => b.dateStamp - a.dateStamp);
        const payload = {
          entries,
          pagination: result.pagination || {},
        };
        const immutableCopy = deepFreeze(cloneDeep(payload));
        postsCache.set(key, immutableCopy);
        const responsePayload = cloneDeep(immutableCopy);

        res.locals.pagination = responsePayload.pagination;
        callback(null, responsePayload.entries);
      });
    }
  );
};

module.exports._createCacheKey = createCacheKey;
module.exports._clear = function () {
  postsCache.clear();
};
