var fourOhFour = require("models/404");

module.exports = function (req, res, next) {
  var blog = req.blog;
  var blogID = blog.id;

  if (!req.body) return next();

  var ignore = req.body.ignore;
  var unignore = req.body.unignore;

  var doThis;
  var url;

  if (ignore) {
    doThis = fourOhFour.ignore;
    url = ignore;
  }

  if (unignore) {
    doThis = fourOhFour.unignore;
    url = unignore;
  }

  if (!doThis || !url)
    return res.redirect(res.locals.base + "/settings/redirects/404s");

  doThis(blogID, url, function (err) {
    if (err) return next(err);

    return res.redirect(res.locals.base + "/settings/redirects/404s");
  });
};
