module.exports = function register(blog) {
  // Prevent robots from indexing
  // preview subdomains to ward off
  // accusations of farming content

  // do the same in case the user
  // has a custom domain as well.
  blog.get("/robots.txt", function (req, res, next) {
    if (
      req.preview ||
      (req.blog.domain && req.originalHost !== req.blog.domain)
    ) {
      res.header("Content-type", "text/plain");
      const robotsContent = `User-agent: *
Disallow: /`;
      return res.send(robotsContent);
    }

    return next();
  });
};
