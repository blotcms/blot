const retrieveTagged = require("../render/retrieve/tagged");

module.exports = function register(blog) {
  blog.get(
    ["/tagged/:tag", "/tagged/:tag/page/:page"],
    async function (req, res, next) {
      try {
        const result = await retrieveTagged(req, res);

        res.locals.slug = encodeURIComponent(req.params.tag);
        res.locals.tag = (result && result.tag) || req.params.tag;
        res.locals.entries = (result && result.entries) || [];
        res.locals.total = (result && result.total) || 0;
        res.locals.pagination = (result && result.pagination) || {};

        res.renderView("tagged.html", next);
      } catch (err) {
        return next(err);
      }
    }
  );
};
