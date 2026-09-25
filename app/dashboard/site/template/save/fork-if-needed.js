const createTemplate = require("./create-template");
const slugForName = require("models/template/util/slugForName");
const makeID = require("models/template/util/makeID");
const Template = require("models/template");
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

// A "site:<slug>" URL (see load/template.js) always loads the SITE-owned
// default, even after the blog has already forked it — that's how it stays
// reachable as a reference/original once a fork with localEditing exists.
// So an edit made from that URL can arrive here with a fork already on
// record. Reuse it instead of trying to create another one, which would
// fail with "A template called X already exists" (Template.create rejects
// a colliding id).
const getExistingFork = (id) => {
  return new Promise((resolve) => {
    Template.getMetadata(id, (err, template) => {
      resolve(err ? null : template || null);
    });
  });
};

module.exports = async (req, res, next) => {
  try {
      const originalTemplate = req.template;
      const originalBlogTemplate = req.blog.template;
      req.templateFork = null;
      res.locals.templateForked = false;

      if (originalTemplate.owner === req.blog.id) return next();

      // Derive the slug from the name so it stays in step with the id the
      // fork is stored under; the source template's slug may not.
      const slug = slugForName(req.blog.id, req.template.name);
      const forkID = makeID(req.blog.id, slug);

      let template = await getExistingFork(forkID);
      const isNewFork = !template;

      if (isNewFork) {
        template = await createTemplate({
            owner: req.blog.id,
            isPublic: false,
            slug,
            name: req.template.name,
            cloneFrom: originalTemplate.id,
        });
      }

      req.templateFork = {
        originalTemplate,
        originalBlogTemplate,
        template,
        isNewFork,
        restoreBlogTemplate: originalBlogTemplate === originalTemplate.id,
      };
      res.locals.templateForked = true;
      req.template = res.locals.template = template;

      // the URL param and any pre-built redirect base still reflect the
      // original request (e.g. a "site:<slug>" reference URL); point them at
      // the template actually being edited from here on.
      const templateSlug = template.id.split(":").slice(1).join(":");
      if (req.params.templateSlug !== templateSlug) {
        req.url = req.url.replace(req.params.templateSlug, templateSlug);
        req.params.templateSlug = templateSlug;
        res.locals.base = `${req.protocol}://${req.hostname}${req.baseUrl}/${templateSlug}`;
      }

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
