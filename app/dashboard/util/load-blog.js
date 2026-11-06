const moment = require("moment");
const config = require("config");
const Blog = require("models/blog");
require("models/template");
const getBlogHealth = require("./get-blog-health");
const { isRedisUnavailableError } = require("helper/redisUnavailable");

// Anything thrown below reaches Express as next(err)
module.exports = (req, res, next, handle) =>
  loadBlog(req, res, next, handle).catch(next);

async function loadBlog(req, res, next, handle) {
  if (!req.session || !req.user || !req.user.blogs.length) return next();
  if (!handle) return next();

  req.handle = handle;

  let blog;
  try {
    blog = await Blog.get({ handle });
  } catch (err) {
    // An outage is not a missing blog
    if (isRedisUnavailableError(err)) return next(err);
    // Any other failure leaves no blog, as the callback form did
    blog = null;
  }

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
}
