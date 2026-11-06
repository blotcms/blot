const querystring = require("querystring");

// Because of our cookie security settings, external
// links (e.g. from email) deep into the dashboard
// do not work properly for logged-in users
// This will insert a redirect page that will allow us
// to extract a session if it actually exists
// We can remove this is we remove the samesite requirement
// from our dashboard session cookies
module.exports = function (req, res, next) {
  const query = querystring.stringify({ ...req.query, redirected: true });
  const redirect =
    req.protocol + "://" + req.hostname + req.baseUrl + req.path + "?" + query;
  const redirected = req.query.redirected;

  if (!redirected) {
    res.locals.cookie_redirect = redirect;
    res.render("dashboard/log-in");
  } else {
    next();
  }
};
