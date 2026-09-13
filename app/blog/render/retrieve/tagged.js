const { getEntry } = require("../../lib/models");
const fetchTaggedEntries = require("./helpers/fetchTaggedEntries");
const projectEntryFields = require("./helpers/projectEntryFields");
const asRetriever = require("../../lib/asRetriever");
const { cloneDeep } = require("../../lib/clone");
const {
  normalizePageNumber,
  normalizePageSize,
} = require("../../lib/pagination");
const getTemplateSortOptions = require("blog/sortOptions");
const { sortEntries } = getTemplateSortOptions;

function normalizeTagsKey(tags) {
  if (Array.isArray(tags)) return tags.map((tag) => String(tag)).sort();
  return tags === undefined ? undefined : String(tags);
}

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

  // routes/tagged.js calls this directly, then render/middleware.js's
  // retrieve pass calls it again for any view that also binds {{#tagged}} -
  // retrieval is driven by the view's static metadata, not by what's
  // already on res.locals, so the second call happens unconditionally.
  // Cache this request's fetch (on req, not a process-wide cache) so the
  // second call reuses it instead of re-running
  // fetchTaggedEntries/Entry.get. See
  // https://github.com/davidmerfield/blot/issues/1844
  const key = JSON.stringify({
    tags: normalizeTagsKey(tags),
    page,
    limit,
    // String(undefined) === "undefined", which would collide with an
    // actual path_prefix of the literal string "undefined" and reuse an
    // unfiltered payload where filterEntryIDsByPathPrefix should have
    // applied a "/undefined" filter. Leave it undefined (JSON.stringify
    // omits the property) instead of collapsing both to the same key.
    pathPrefix: pathPrefix === undefined ? undefined : String(pathPrefix),
    sortBy: String(sortOptions.sortBy),
    order: String(sortOptions.order),
  });

  let payload;

  if (req._taggedFetch && req._taggedFetch.key === key) {
    payload = req._taggedFetch.payload;
  } else {
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
      result.total !== undefined
        ? result.total
        : (result.entryIDs || []).length;

    payload = {
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

    req._taggedFetch = { key, payload };
  }

  res.locals.pagination = res.locals.pagination || payload.pagination || {};

  // Clone before projecting: a reused payload may be shared with a
  // different call site (routes/tagged.js's own {{#entries}} local), and
  // projection deletes fields in place. Preserve Entry prototypes so
  // render-time augmentation (date/formatDate/absoluteURL/tags helpers)
  // still applies - see render/load/eachEntry.js.
  const entries = cloneDeep(payload.entries, { preserveEntryInstances: true });
  projectEntryFields(entries, req.retrieve, ["tagged"]);

  return { ...payload, entries };
}

module.exports = asRetriever(tagged);
