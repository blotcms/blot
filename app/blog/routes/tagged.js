// A fetch error here (other than the statusCode case retrieve/index.js
// re-throws) no longer reaches next(err)/error.html - it's swallowed and the
// page renders with tagged/entries missing. See the note in
// render/retrieve/index.js.
module.exports = function register(blog) {
  blog.get(
    ["/tagged/:tag", "/tagged/:tag/page/:page"],
    function (req, res, next) {
      // Lets the tagged retriever answer 404 for a tag with no posts
      req.tagPage = true;
      res.renderView("tagged.html", next);
    }
  );
};
