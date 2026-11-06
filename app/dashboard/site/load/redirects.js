const Redirects = require("models/redirects");

module.exports = function (req, res, next) {
  Redirects.list(req.blog.id, function (err, redirects) {
    res.locals.redirects = redirects;
    res.locals.redirectsEmptyDisplay =
      redirects && redirects.length ? "none" : "block";
    next();
  });
};
