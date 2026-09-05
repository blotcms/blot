const Redirects = require("models/redirects");

// Explains why a redirect will never run, e.g. because a post already
// exists at the URL it redirects from. The warnings are a nicety, so if we
// can't work them out we still render the list of redirects.
module.exports = function (req, res, next) {
  const redirects = res.locals.redirects;

  if (!redirects || !redirects.length) return next();

  Redirects.conflicts(req.blog, redirects, function (err, conflicts) {
    if (err) {
      console.error("Failed to check redirects for conflicts", err);
      return next();
    }

    let total = 0;

    redirects.forEach(function (redirect, index) {
      if (!conflicts[index]) return;

      redirect.warning = conflicts[index].message;
      total++;
    });

    res.locals.redirectWarnings = total;

    next();
  });
};
