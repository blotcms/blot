const Blog = require("models/blog");
const Template = require("models/template");
const config = require("config");
const getBlogHealth = require("./get-blog-health");

module.exports = async function (req, res, next) {
  if (!req.session || !req.user || !req.user.blogs.length) return next();

  try {
    // Fetch and extend blogs along with their templates' metadata
    const blogs = await Promise.all(
      req.user.blogs.map(async (blogID) => {
        let blog = await Blog.get({ id: blogID });
        if (!blog) return null;

        blog = Blog.extend(blog);

        // Fetch template metadata
        // (a failed lookup leaves the blog's template unextended)
        const metadata = await Template.getMetadata(blog.template).catch(
          () => undefined
        );

        if (metadata) {
          // Assign the metadata and construct the previewURL
          blog.template = metadata;
          blog.previewURL = `https://preview-of-${metadata.owner === blog.id ? "my-" : ""}${metadata.slug}-on-${blog.handle}.${config.host}?screenshot=true`;
        }

        return blog;
      })
    );

    const existing = blogs.filter((blog) => blog !== null);

    await Promise.all(existing.map(getBlogHealth));

    req.blogs = res.locals.blogs = existing;

    next();
  } catch (error) {
    next(error);
  }
};
