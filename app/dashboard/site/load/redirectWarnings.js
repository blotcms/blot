const Redirects = require("models/redirects");

// Explains why a redirect will never run, e.g. because a post already
// exists at the URL it redirects from. The warnings are a nicety, so if we
// can't work them out we still render the list of redirects.
module.exports = async function (req, res, next) {
  try {
    const redirects = res.locals.redirects;

    if (!redirects || !redirects.length) return next();

    let conflicts;

    try {
      conflicts = await Redirects.conflicts(req.blog, redirects);
    } catch (err) {
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
  } catch (err) {
    next(err);
  }
};
