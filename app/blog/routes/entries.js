// A fetch error here (other than the statusCode case retrieve/index.js
// re-throws) no longer reaches next(err)/error.html - it's swallowed and the
// page renders with posts/entries missing. See the note in
// render/retrieve/index.js.
module.exports = function entries(req, res, next) {
  res.renderView("entries.html", next);
};
