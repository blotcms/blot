const getTemplateSortOptions = require("blog/sortOptions");
const { searchEntries } = require("../../lib/models");
const projectEntryFields = require("./helpers/projectEntryFields");
const asRetriever = require("../../lib/asRetriever");

async function searchResults(req, res) {
  const blogID = req.blog.id;

  // We couldn't find a search query
  if (!req.query.q) {
    return [];
  }

  const sortOptions = getTemplateSortOptions(req.template && req.template.locals);

  // Entry.search collects a wide candidate pool, then sorts and caps by the
  // selection (a missing selection normalises to newest-first date).
  const results = await searchEntries(blogID, req.query.q, sortOptions);

  // The HTML was only needed to match against the query; drop the heavy
  // fields the search view does not render.
  return projectEntryFields(results, req.retrieve, ["search_results"]);
};

module.exports = asRetriever(searchResults);
