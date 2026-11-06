const loadBlogs = require("./load-blogs");
const Similarity = require("helper/similarity");

module.exports = async function (err, req, res, next) {
  if (err.message !== "No blog") return next(err);
  try {
    await new Promise((resolve, reject) => {
      loadBlogs(req, res, function (err) {
        if (err) return reject(err);
        resolve();
      });
    });
    if (!req.handle || !req.blogs.length) return next();
    let handle = req.handle;
    let handleToRedirect;
    let pathWithoutHandle = req.path.slice(("/sites/" + handle).length);
    let similarity;

    req.blogs.forEach((blog) => {
      let candidateSimilarity = Similarity(handle, blog.handle);
      if (!handleToRedirect || candidateSimilarity > similarity) {
        handleToRedirect = blog.handle;
        similarity = candidateSimilarity;
      }
    });

    res.redirect(`/sites/${handleToRedirect}${pathWithoutHandle}`);
  } catch (error) {
    next(error);
  }
};
