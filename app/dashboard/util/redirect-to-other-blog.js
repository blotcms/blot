const loadBlogs = require("./load-blogs").basic;
const Similarity = require("helper/similarity");

// Below this a handle is a different site, not a typo of one, so the
// request gets the 404 page rather than another site's page
const MIN_SIMILARITY = 0.6;

module.exports = function (err, req, res, next) {
  if (err.message !== "No blog") return next(err);
  err.status = 404;
  loadBlogs(req, res, function (loadErr) {
    if (loadErr) return next(loadErr);
    if (!req.handle || !req.blogs.length) return next(err);
    let handle = req.handle;
    let handleToRedirect;
    // The rest of the URL after /sites/<handle>, query included (req.path is
    // relative to where the dashboard is mounted, so use originalUrl)
    let pathWithoutHandle = req.originalUrl.slice(
      req.originalUrl.indexOf("/" + handle) + handle.length + 1
    );
    let similarity;

    req.blogs.forEach((blog) => {
      let candidateSimilarity = Similarity(handle, blog.handle);
      if (!handleToRedirect || candidateSimilarity > similarity) {
        handleToRedirect = blog.handle;
        similarity = candidateSimilarity;
      }
    });

    if (similarity < MIN_SIMILARITY) return next(err);

    res.redirect(`/sites/${handleToRedirect}${pathWithoutHandle}`);
  });
};
