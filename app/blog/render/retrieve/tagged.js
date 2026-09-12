const { getEntry } = require("../../lib/models");
const fetchTaggedEntries = require("./helpers/fetchTaggedEntries");
const projectEntryFields = require("./helpers/projectEntryFields");
const asRetriever = require("../../lib/asRetriever");
const {
  normalizePageNumber,
  normalizePageSize,
} = require("../../lib/pagination");
const getTemplateSortOptions = require("blog/sortOptions");
const { sortEntries } = getTemplateSortOptions;

async function tagged(req, res) {
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

  const result = await fetchTaggedEntries(blogID, tags, {
    limit,
    offset,
    pathPrefix,
    ...sortOptions,
  });

  const entryIDs = result.entryIDs || [];

  let entries = await getEntry(blogID, entryIDs);

  entries = sortEntries(entries, sortOptions);
  projectEntryFields(entries, req.retrieve, ["tagged"]);

  const totalEntries =
    result.total !== undefined ? result.total : (result.entryIDs || []).length;

  res.locals.pagination = res.locals.pagination || result.pagination || {};

  return {
    tag: result.tag,
    tagged: result.tagged,
    is: result.tagged, // alias
    entries,
    pagination: result.pagination,
    total: totalEntries,
    entryIDs: result.entryIDs || [],
    slugs: result.slugs,
    prettyTags: result.prettyTags,
  };
};

module.exports = asRetriever(tagged);
