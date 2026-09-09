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
    res.locals.templateForked = false;

    if (req.template.owner === req.blog.id) {
        return next();
    }

    const template = await createTemplate({
        isPublic: false,
        owner: req.blog.id,
        // Derive the slug from the name so it stays in step with the id the
        // fork is stored under; the source template's slug may not.
        slug: slugForName(req.blog.id, req.template.name),
        name: req.template.name,
        cloneFrom: req.template.id,
    });

    // if the blog used to use the forked template, we need to update the blog's template
    if (req.blog.template === req.template.id) {
        await updateBlog(req.blog.id, {
            template: template.id
        });
    }

    res.locals.templateForked = true;
    req.template = res.locals.template = template;
    next();
};
