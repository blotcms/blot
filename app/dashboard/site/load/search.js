const Entry = require("models/entry");
const Stat = require("../folder/stat");
const getTemplateSortOptions = require("blog/sortOptions");
const searchQueryString = require("blog/lib/searchQuery");

// The results are listed like the folder's files: name, size and date
// modified, from a stat of each (at most 25, see models/entry/search.js)
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
    async function (err, entries) {
      if (err) return next(err);

      try {
        res.locals.searchResults = await Promise.all(
          entries.map(async function (entry) {
            const path = entry.path || entry.id;
            // A file removed since it was indexed shows without a size or date
            const stat = await Stat(req.blog.id, path, req.blog.timeZone).catch(
              () => null
            );

            return {
              name: path.split("/").pop(),
              path: path,
              urlPath: path
                .replace(/^\/+/, "")
                .split("/")
                .map(encodeURIComponent)
                .join("/"),
              size: stat ? stat.size : "--",
              modified: stat ? stat.modified : "",
            };
          })
        );
      } catch (err) {
        return next(err);
      }

      next();
    }
  );
};
