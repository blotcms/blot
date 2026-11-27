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
  // A browser leaves quotes in a path as they are; encoded, the address is
  // safe in the meta refresh's quoted URL, and the script gets it as a JSON
  // string with "<" escaped so it can't close the script element
  const redirect = (
    req.protocol +
    "://" +
    req.hostname +
    req.baseUrl +
    req.path +
    "?" +
    query
  ).replace(/'/g, "%27");
  const redirected = req.query.redirected;

  if (!redirected) {
    res.locals.cookie_redirect = redirect;
    res.locals.cookie_redirect_json = JSON.stringify(redirect).replace(
      /</g,
      "\\u003c"
    );
    res.render("dashboard/log-in");
  } else {
    next();
  }
};
