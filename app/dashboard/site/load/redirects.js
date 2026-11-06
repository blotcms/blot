const Redirects = require("models/redirects");

module.exports = async function (req, res, next) {
  try {
    // A failed read leaves the redirects empty, as the callback form did
    res.locals.redirects = await Redirects.list(req.blog.id).catch(
      () => undefined
    );
    next();
  } catch (err) {
    next(err);
  }
};
