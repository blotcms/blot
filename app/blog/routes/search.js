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
      res.locals.entries =
        (await searchEntries(req.blog.id, query, sortOptions)) || [];
    }

    // Don't cache search results
    res.set("Cache-Control", "no-cache");
    res.renderView("search.html", next);
  } catch (err) {
    return next(err);
  }
};
