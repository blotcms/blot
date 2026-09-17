const searchQueryString = require("../lib/searchQuery");

const LISTING_RETRIEVE = {
  "entries.html": "posts",
  "tagged.html": "tagged",
  "search.html": "search_results",
};

// Older listing templates bind {{#entries}} (and search {{query}}) instead of
// the retriever names. Force that retriever so those views still load, then
// alias the old top-level locals from the same payload. Do not add an
// `entries` retriever: nested {{#archives}}/{{#tagged}} {{#entries}} would
// start fetching the listing page.
function ensureRetrieve(viewName, needed) {
  const key = LISTING_RETRIEVE[viewName];
  if (!key || !needed) return;
  if (needed[key] === undefined) needed[key] = {};
}

function aliasLocals(viewName, req, res, foundLocals) {
  if (!foundLocals) return;

  if (viewName === "entries.html" && foundLocals.posts !== undefined) {
    res.locals.entries = foundLocals.posts;
    return;
  }

  if (viewName === "tagged.html" && foundLocals.tagged) {
    const tagged = foundLocals.tagged;
    res.locals.entries = tagged.entries || [];
    res.locals.tag = tagged.tag || (req.params && req.params.tag);
    res.locals.total = tagged.total || 0;
    res.locals.pagination = tagged.pagination || {};
    if (req.params && req.params.tag !== undefined) {
      res.locals.slug = encodeURIComponent(req.params.tag);
    }
    return;
  }

  if (viewName === "search.html") {
    if (foundLocals.search_results !== undefined) {
      res.locals.entries = foundLocals.search_results;
    }
    const query = searchQueryString(req.query && req.query.q);
    // extend() already copied req.query onto res.locals.query (an object).
    // Old search templates interpolate {{query}} as a string.
    res.locals.query = typeof query === "string" ? query : "";
  }
}

module.exports = { ensureRetrieve, aliasLocals };
