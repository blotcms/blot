const Redirects = require("models/redirects");

module.exports = async function (req, res, next) {
  try {
    // A failed read leaves the redirects empty, as the callback form did
    const redirects = await Redirects.list(req.blog.id).catch(() => undefined);
    res.locals.redirects = redirects;
    res.locals.redirectsEmptyDisplay =
      redirects && redirects.length ? "none" : "block";
    next();
  } catch (err) {
    next(err);
  }
};
