const Entry = require("models/entry");
const getTemplateSortOptions = require("blog/sortOptions");
const searchQueryString = require("blog/lib/searchQuery");

module.exports = function (req, res, next) {
  const rawQuery = searchQueryString(req.query.q);
  const query = typeof rawQuery === "string" ? rawQuery.trim() : "";

  res.locals.searchQuery = query;
  res.locals.searchResults = [];

  if (!query) return next();

  Entry.search(
    req.blog.id,
    query,
    getTemplateSortOptions(req.template && req.template.locals),
    function (err, entries) {
      if (err) return next(err);

      res.locals.searchResults = entries.map(function (entry) {
        const path = entry.path || entry.id;

        return {
          title: entry.title || path,
          path: path,
          urlPath: path
            .replace(/^\/+/, "")
            .split("/")
            .map(encodeURIComponent)
            .join("/"),
        };
      });

      next();
    }
  );
};
