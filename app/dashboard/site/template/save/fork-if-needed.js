const createTemplate = require("./create-template");
const slugForName = require("models/template/util/slugForName");
const Blog = require("models/blog");

const updateBlog = (blogID, updates) => {
    return new Promise((resolve, reject) => {
        Blog.set(blogID, updates, function (error) {
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        });
    });
}

module.exports = async (req, res, next) => {
  try {
      const originalTemplate = req.template;
      const originalBlogTemplate = req.blog.template;
      req.templateFork = null;
      res.locals.templateForked = false;

      if (originalTemplate.owner === req.blog.id) return next();

      const template = await createTemplate({
          owner: req.blog.id,
          isPublic: false,
          // Derive the slug from the name so it stays in step with the id the
          // fork is stored under; the source template's slug may not.
          slug: slugForName(req.blog.id, req.template.name),
          name: req.template.name,
          cloneFrom: originalTemplate.id,
      });

      req.templateFork = {
        originalTemplate,
        originalBlogTemplate,
        template,
        restoreBlogTemplate: originalBlogTemplate === originalTemplate.id,
      };
      res.locals.templateForked = true;
      req.template = res.locals.template = template;

      // if the blog used to use the forked template, we need to update the blog's template
      if (req.templateFork.restoreBlogTemplate) {
          await updateBlog(req.blog.id, {
              template: template.id
          });
          req.blog.template = template.id;
      }

      return next();
  } catch (err) {
    return next(err);
  }
};
