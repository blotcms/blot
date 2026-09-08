module.exports = function loadFavicon(req, res, next) {
  res.locals.favicon = req.template.locals.favicon || null;
  next();
};
