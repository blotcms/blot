const Tags = require("models/tags");
const projectEntryFields = require("./helpers/projectEntryFields");
const listPagination = require("./helpers/listPagination");
const asRetriever = require("../../lib/asRetriever");
const {
  normalizePageNumber,
  normalizePageSize,
} = require("../../lib/pagination");
const paginationURLs = require("../../lib/paginationURLs");
const getTemplateSortOptions = require("blog/sortOptions");

const ALIASES = ["tagged", "entries"];

// The tagged page, from Tags.getCachedTagged, which caches it per blog
// cacheID and already leaves out the heavy fields this view doesn't render.
// The page size is tagged_page_size || page_size, unlike posts.js's
// tag-filtered branch, so the two share a cached page only when those match.
async function tagged(req, res) {
  const log = typeof req?.log === "function" ? req.log.bind(req) : () => {};
  const blogID = req.blog.id;
  const tags =
    req.query.name ||
    req.query.tag ||
    req.params.tag ||
    (res.locals && res.locals.tag) ||
    "";

  // ?page= too, for views without a :page pattern (see lib/paginationURLs)
  const page = normalizePageNumber(req.params.page ?? req.query.page);

  const templateLocals = (req.template && req.template.locals) || {};
  const pathPrefix =
    (res.locals && res.locals.path_prefix) ?? templateLocals.path_prefix;
  const sortOptions = getTemplateSortOptions(templateLocals);

  const preferredLimit =
    templateLocals.tagged_page_size !== undefined
      ? templateLocals.tagged_page_size
      : templateLocals.page_size;

  const limit = normalizePageSize(preferredLimit);

  const payload = await Tags.getCachedTagged(blogID, tags, {
    limit,
    offset: (page - 1) * limit,
    pathPrefix,
    sortBy: sortOptions.sortBy,
    order: sortOptions.order,
    keep: projectEntryFields.heavyFieldsToKeep(req.retrieve, ALIASES),
    cacheID: req.blog.cacheID,
    log,
  });

  // A copy with next_url and previous_url, which depend on the request
  const pagination = paginationURLs(req, payload.pagination);

  res.locals.pagination = res.locals.pagination || pagination;

  // {{#tagged.pagination}} is the documented form; this also gives
  // {{#entries.pagination}} on tagged.html and the last-entry copy
  listPagination(payload.entries, pagination);

  return { ...payload, pagination, is: payload.tagged }; // is: an alias
}

module.exports = asRetriever(tagged);
