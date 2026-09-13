const getTemplateSortOptions = require("blog/sortOptions");
const { searchEntries } = require("../../lib/models");
const projectEntryFields = require("./helpers/projectEntryFields");
const asRetriever = require("../../lib/asRetriever");
const { cloneDeep } = require("../../lib/clone");

async function searchResults(req, res) {
  const blogID = req.blog.id;

  // routes/search.js joins a repeated ?q= into a single string before
  // scanning; match that here so the comparison below (and the fallback
  // search) see the same query it did, not the raw array.
  const query = Array.isArray(req.query.q) ? req.query.q.join(" ") : req.query.q;

  // We couldn't find a search query
  if (!query) {
    return [];
  }

  const sortOptions = getTemplateSortOptions(req.template && req.template.locals);

  // routes/search.js already scanned for this exact query + sort selection
  // earlier in this request - reuse it instead of running Entry.search
  // again (a second full scan over entry.html is the heap concern this
  // guards against - see
  // https://github.com/davidmerfield/blot/issues/1844). Clone before
  // projecting: the reused array is shared with res.locals.entries and
  // projection below deletes fields in place. Preserve Entry prototypes so
  // render-time augmentation (date/formatDate/absoluteURL/tags helpers)
  // still applies - see render/load/eachEntry.js.
  const scan = req._searchScan;
  const reusable =
    scan &&
    scan.query === query &&
    JSON.stringify(scan.sortOptions) === JSON.stringify(sortOptions);

  const results = reusable
    ? cloneDeep(scan.entries, { preserveEntryInstances: true })
    : // Entry.search collects a wide candidate pool, then sorts and caps by
      // the selection (a missing selection normalises to newest-first date).
      await searchEntries(blogID, query, sortOptions);

  // The HTML was only needed to match against the query; drop the heavy
  // fields the search view does not render.
  return projectEntryFields(results, req.retrieve, ["search_results"]);
};

module.exports = asRetriever(searchResults);
