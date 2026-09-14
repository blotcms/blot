const Template = require("models/template");

const hasFaviconLocal = (value) => {
  if (!value || typeof value !== "object") return false;
  if (Object.prototype.hasOwnProperty.call(value, "favicon")) return true;

  return Object.values(value).some(hasFaviconLocal);
};

const templateSupportsFavicon = (template, views) => {
  if (hasFaviconLocal(template && template.locals)) return true;

  return Object.values(views || {}).some((view) =>
    hasFaviconLocal(view && view.retrieve) ||
    hasFaviconLocal(view && view.locals)
  );
};

module.exports = function loadFavicon(req, res, next) {
  res.locals.favicon = req.template.locals.favicon || null;

  if (hasFaviconLocal(req.template.locals)) {
    res.locals.favicon_supported = true;
    return next();
  }

  Template.getAllViews(req.template.id, function (err, views) {
    if (err) return next(err);

    res.locals.favicon_supported = templateSupportsFavicon(
      req.template,
      views
    );

    next();
  });
};

module.exports.hasFaviconLocal = hasFaviconLocal;
module.exports.templateSupportsFavicon = templateSupportsFavicon;
