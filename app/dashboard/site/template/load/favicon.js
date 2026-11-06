const Template = require("models/template");
const { LRUCache } = require("lru-cache");

// Whether a template's views use a favicon only changes when a view does,
// which bumps the template's cacheID (stored in Redis, so blue and green
// agree). Saves reading every view on each editor page.
const supported = new LRUCache({ max: 5000 });

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

module.exports = function loadFavicon(req, res, next) {
  res.locals.favicon = req.template.locals.favicon || null;

  if (hasFaviconLocal(req.template.locals)) {
    res.locals.favicon_supported = true;
    return next();
  }

  const key = req.template.id + ":" + req.template.cacheID;

  if (req.template.cacheID && supported.has(key)) {
    res.locals.favicon_supported = supported.get(key);
    return next();
  }

  Template.getAllViews(req.template.id, function (err, views) {
    if (err) return next(err);

    res.locals.favicon_supported = templateSupportsFavicon(req.template, views);

    if (req.template.cacheID) supported.set(key, res.locals.favicon_supported);

    next();
  });
};

module.exports.hasFaviconLocal = hasFaviconLocal;
module.exports.templateSupportsFavicon = templateSupportsFavicon;
