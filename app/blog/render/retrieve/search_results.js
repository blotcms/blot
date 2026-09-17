const getTemplateSortOptions = require("blog/sortOptions");
const { searchEntries } = require("../../lib/models");
const searchQueryString = require("../../lib/searchQuery");
const projectEntryFields = require("./helpers/projectEntryFields");
const asRetriever = require("../../lib/asRetriever");

async function searchResults(req, res) {
  const blogID = req.blog.id;
  const query = searchQueryString(req.query.q);

  if (!query || typeof query !== "string") {
    return [];
  }

  const sortOptions = getTemplateSortOptions(req.template && req.template.locals);

  // Entry.search collects a wide candidate pool, then sorts and caps by
  // the selection (a missing selection normalises to newest-first date).
  const results = await searchEntries(blogID, query, sortOptions);

  // The HTML was only needed to match against the query; drop the heavy
  // fields the search view does not render. `entries` is included so a
  // listing view that also binds {{#entries}} does not lose html.
  return projectEntryFields(results, req.retrieve, ["search_results", "entries"]);
}

module.exports = asRetriever(searchResults);
