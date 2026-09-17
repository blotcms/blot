const searchQueryString = require("../lib/searchQuery");

// A search_results fetch error (other than the statusCode case
// retrieve/index.js re-throws) no longer reaches next(err)/error.html - it's
// swallowed and the page renders with no results. See the note in
// render/retrieve/index.js.
module.exports = function (req, res, next) {
  const query = searchQueryString(req.query.q || "");

  // Non-string q (e.g. ?q[foo]=bar) → 404. Do not fall through to view middleware.
  if (typeof query !== "string") {
    res.status(404);
    res.locals.error = {
      title: "Page not found",
      message: "There is no page with this URL.",
      status: 404,
    };
    return res.renderView("error.html", next);
  }

  res.set("Cache-Control", "no-cache");
  res.renderView("search.html", next);
};
