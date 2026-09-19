const Blog = require("models/blog");
const Template = require("models/template");
const config = require("config");
const getBlogHealth = require("./get-blog-health");

module.exports = async function (req, res, next) {
  if (!req.session || !req.user || !req.user.blogs.length) return next();

  try {
    // Fetch and extend blogs along with their templates' metadata
    const blogs = await Promise.all(
      req.user.blogs.map((blogID) => {
        return new Promise((resolve, reject) => {
          Blog.get({ id: blogID }, (err, blog) => {
            if (err) return reject(err);
            if (!blog) return resolve(null);

            try {
              blog = Blog.extend(blog);
            } catch (e) {
              return reject(e);
            }

            // Fetch template metadata
            Template.getMetadata(blog.template, (err, metadata) => {

              if (metadata) {
                // Assign the metadata and construct the previewURL
                blog.template = metadata;
                blog.previewURL = `https://preview-of-${metadata.owner === blog.id ? 'my-' : ''}${metadata.slug}-on-${blog.handle}.${config.host}?screenshot=true`;
              }

              resolve(blog);
            });
          });
        });
      })
    );

    const existing = blogs.filter(blog => blog !== null);

    await Promise.all(existing.map(getBlogHealth));

    req.blogs = res.locals.blogs = existing;
    
    next();
  } catch (error) {
    next(error);
  }
};