const Blog = require("models/blog");
const Template = require("models/template");
const config = require("config");
const readOnly = require("helper/readOnly");
const getBlogHealth = require("./get-blog-health");

async function getBlog(id) {
  const blog = await Blog.get({ id });
  return blog ? Blog.extend(blog) : null;
}

async function addTemplate(blog) {
  const metadata = await Template.getMetadata(blog.template).catch(() => null);
  if (!metadata) return;
  blog.template = metadata;
  blog.previewURL = `https://preview-of-${metadata.owner === blog.id ? "my-" : ""}${metadata.slug}-on-${blog.handle}.${config.host}?screenshot=true`;
}

async function getBlogs(req) {
  const blogs = await Promise.all(req.user.blogs.map(getBlog));
  return blogs.filter(Boolean);
}

// Each blog with its template metadata and sync health, for the sites list
async function loadBlogs(req, res, next) {
  if (!req.session || !req.user || !req.user.blogs.length) return next();

  try {
    const blogs = await getBlogs(req);
    // One read-only check for every blog's health, not one each
    const frozen = readOnly.status().catch(() => null);
    await Promise.all(
      blogs.map((blog) =>
        Promise.all([addTemplate(blog), getBlogHealth(blog, frozen)])
      )
    );
    req.blogs = res.locals.blogs = blogs;
    next();
  } catch (error) {
    next(error);
  }
}

// Just the blogs, for the site switcher and redirects
loadBlogs.basic = async function (req, res, next) {
  if (!req.session || !req.user || !req.user.blogs.length) return next();

  try {
    req.blogs = res.locals.blogs = await getBlogs(req);
    next();
  } catch (error) {
    next(error);
  }
};

module.exports = loadBlogs;
