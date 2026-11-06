const Template = require("models/template");

const hasFaviconLocal = (value) => {
  if (!value || typeof value !== "object") return false;
  if (Object.prototype.hasOwnProperty.call(value, "favicon")) return true;

  return Object.values(value).some(hasFaviconLocal);
};

const templateSupportsFavicon = (template, views) => {
  if (hasFaviconLocal(template && template.locals)) return true;

  return Object.values(views || {}).some(
    (view) =>
      hasFaviconLocal(view && view.retrieve) ||
      hasFaviconLocal(view && view.locals)
  );
};

module.exports = async function loadFavicon(req, res, next) {
  try {
    res.locals.favicon = req.template.locals.favicon || null;

    if (hasFaviconLocal(req.template.locals)) {
      res.locals.favicon_supported = true;
      return next();
    }

    const result = await Template.getAllViews(req.template.id);

    res.locals.favicon_supported = templateSupportsFavicon(
      req.template,
      result.views
    );

    next();
  } catch (err) {
    next(err);
  }
};

module.exports.hasFaviconLocal = hasFaviconLocal;
module.exports.templateSupportsFavicon = templateSupportsFavicon;
