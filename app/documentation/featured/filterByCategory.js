// Filters res.locals.featured.sites (already populated by ./index.js)
// down to the sites whose bio matches the requested category, then
// renders the examples view directly since this route lives outside
// the generic path-to-view middleware in ../index.js.
const { categoryForSlug, filterSitesByCategory } = require("./categories");

module.exports = function (req, res, next) {
  const category = categoryForSlug(req.params.category);

  if (!category || !res.locals.featured) {
    const err = new Error("Page not found");
    err.status = 404;
    return next(err);
  }

  res.locals.featured = {
    ...res.locals.featured,
    sites: filterSitesByCategory(res.locals.featured.sites, category.slug),
  };

  res.locals.title = `${category.label} – Blot Examples`;
  res.locals.hidebreadcrumbs = true;

  res.render("examples");
};
