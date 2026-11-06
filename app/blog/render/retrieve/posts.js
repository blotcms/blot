const Entries = require("models/entries");
const Tags = require("models/tags");
const projectEntryFields = require("./helpers/projectEntryFields");
const getTemplateSortOptions = require("blog/sortOptions");
const asRetriever = require("../../lib/asRetriever");
const {
  normalizePageNumber,
  normalizePageSize,
} = require("../../lib/pagination");

// Include `entries` so a listing view that also binds {{#entries}} (whose
// fields parseTemplate does not record on `posts`) keeps what it renders.
const ALIASES = ["posts", "entries"];

// A page of entries, from the models' caches (Entries.getCachedPage, or
// Tags.getCachedTagged for a tag-filtered page), which already leave out the
// heavy fields this view doesn't render. Nothing here depends on the
// template beyond those fields and its sort and page size, so there is no
// cache of its own.
async function posts(req, res) {
  const blogID = req?.blog?.id;
  const log = typeof req?.log === "function" ? req.log.bind(req) : () => {};

  const sortOptions = getTemplateSortOptions(req?.template?.locals);
  const keep = projectEntryFields.heavyFieldsToKeep(
    req && req.retrieve,
    ALIASES
  );
  const cached = { keep, cacheID: req?.blog?.cacheID, log };

  const options = {
    sortBy: sortOptions.sortBy,
    order: sortOptions.order,
    pageNumber: req?.params?.page ?? req?.query?.page,
    pageSize: res.locals?.page_size ?? req?.template?.locals?.page_size,
    pathPrefix: res.locals?.path_prefix ?? req?.template?.locals?.path_prefix,
  };

  const tags = req?.query?.tag || req?.params?.tag || res?.locals?.tag;

  let page;

  if (!tags) {
    log("Loading page of entries");
    // Forward the raw, unnormalized pageNumber/pageSize here: models/entries
    // getPage does its own validation (default page size 5, max 100, and a
    // 400 for a non-digit :page) which bots probe for. lib/pagination's
    // normalizePageNumber/normalizePageSize have different defaults (100/500)
    // and never reject, so they're only used for the tagged branch.
    page = await Entries.getCachedPage(blogID, { ...options, ...cached });
  } else {
    log("Loading tagged page of entries");
    const pageNumber = normalizePageNumber(options.pageNumber);
    const pageSize = normalizePageSize(options.pageSize);
    const result = await Tags.getCachedTagged(blogID, tags, {
      limit: pageSize,
      offset: (pageNumber - 1) * pageSize,
      pathPrefix: options.pathPrefix,
      sortBy: options.sortBy,
      order: options.order,
      ...cached,
    });
    page = { entries: result.entries, pagination: result.pagination || {} };
  }

  res.locals.pagination = page.pagination;
  return page.entries;
}

module.exports = asRetriever(posts);
