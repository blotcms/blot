var getTemplateSortOptions = require("blog/sortOptions");
var Entry = require("models/entry");

module.exports = function (req, res, callback) {
  var blogID = req.blog.id;

  // We couldn't find a search query
  if (!req.query.q) {
    return callback(null, []);
  }

  var sortOptions = getTemplateSortOptions(req.template && req.template.locals);

  // Entry.search collects a wide candidate pool, then sorts and caps by the
  // selection (a missing selection normalises to newest-first date).
  Entry.search(blogID, req.query.q, sortOptions, callback);
};
