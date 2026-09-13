const { searchEntries } = require("../lib/models");
const getTemplateSortOptions = require("blog/sortOptions");

module.exports = async (req, res, next) => {
  try {
    let query = req.query.q || "";

    // if the query is an array (e.g. q=foo&q=bar)
    // we need to join it into a single string
    if (Array.isArray(query)) {
      query = req.query.q.join(" ");
    }

    // if the query variable is not a string, respond with 404 (don't fall through to view middleware)
    if (typeof query !== "string") {
      res.status(404);
      res.locals.error = {
        title: "Page not found",
        message: "There is no page with this URL.",
        status: 404,
      };
      return res.renderView("error.html", next);
    }

    if (query) {
      res.locals.query = query;
      const sortOptions = getTemplateSortOptions(
        req.template && req.template.locals
      );
      // Entry.search sorts and caps by the selection before returning.
      const entries =
        (await searchEntries(req.blog.id, query, sortOptions)) || [];
      res.locals.entries = entries;

      // Views that also bind {{#search_results}} would otherwise trigger a
      // second full-body Entry.search scan in the same request (the scan
      // matches against entry.html and holds up to MAX_COLLECT full entries
      // before slicing - see
      // https://github.com/davidmerfield/blot/issues/1844). Stash this
      // request's scan so retrieve/search_results.js can reuse it. Not a
      // process-wide cache: req is discarded at the end of the request.
      req._searchScan = { query, sortOptions, entries };
    }

    // Don't cache search results
    res.set("Cache-Control", "no-cache");
    res.renderView("search.html", next);
  } catch (err) {
    return next(err);
  }
};
