const moment = require("moment");
const config = require("config");
const Blog = require("models/blog");
const Template = require("models/template");
const getBlogHealth = require("./get-blog-health");

module.exports = function (req, res, next, handle) {
  if (!req.session || !req.user || !req.user.blogs.length) return next();
  if (!handle) return next();

  req.handle = handle;

  Blog.get({ handle }, function (err, blog) {
    if (!blog || blog.owner !== req.user.uid) return next(new Error("No blog"));

    try {
      blog = Blog.extend(blog);

      if (blog.status && blog.status.message === "Synced") {
        blog.status.state = "synced";
      }

      if (blog.status && blog.status.message !== "Synced") {
        blog.status.state = "syncing";
      }

      blog.updated = moment(blog.cacheID).fromNow();
    } catch (e) {
      return next(e);
    }

    getBlogHealth(blog).then(function () {
      finish(blog);
    }, next);
  });

  function finish(blog) {
    const siteTemplate = blog.template.startsWith("SITE:");
    const slug = blog.template.split(":").slice(1).join(":");

    res.locals.template = { slug, id: blog.template };
    res.locals.previewURL = `https://preview-of-${
      siteTemplate ? "" : "my-"
    }${slug}-on-${blog.handle}.${config.host}`;

    req.blog = blog;
    res.locals.blog = blog;
    if (req.session) req.session.lastBlogHandle = blog.handle;
    res.locals.base = `/sites/${req.params.handle}`;
    res.locals.dashboardBase = res.locals.base; // alias for use in clients
    res.locals.breadcrumbs.add("Sites", "/sites");
    res.locals.breadcrumbs.add(req.blog.pretty.label, `${req.params.handle}`);
    res.locals.title = req.blog.pretty.label;
    next();
  }
};
