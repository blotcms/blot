var config = require("config");
var Template = require("models/template");
var makeSlug = require("helper/makeSlug");

// should return a template owned by the blog, if it exists,
// or a template owned by the site if it exists or null if neither exist
const loadTemplate = async (blogID, templateSlug) => {
  const slug = makeSlug(templateSlug);
  const defaultTemplate = await getMetadata(Template.makeID("SITE", slug));
  const blogTemplate = await getMetadata(Template.makeID(blogID, slug));

  if (blogTemplate && defaultTemplate) {
    // both templates exist, return the blog template
    // but mark it as a mirror template
    blogTemplate.isMirror = true;
    return blogTemplate;
  }

  if (blogTemplate) {
    return blogTemplate;
  }

  if (defaultTemplate) {
    return defaultTemplate;
  }

  return null;
};

const getMetadata = (templateID) => {
  return new Promise((resolve, reject) => {
    Template.getMetadata(templateID, (err, template) => {
      if (err || !template) return resolve(null);
      resolve(template);
    });
  });
};

module.exports = async function (req, res, next) {
  try {
    const slug = makeSlug(req.params.templateSlug);
    const template = await loadTemplate(req.blog.id, slug);
    const templateMissing = !template;

    const hydrated = template || {
      owner: req.blog.id,
      slug,
      id: Template.makeID(req.blog.id, slug),
      locals: {},
      partials: {},
      previewPath: "",
    };

    hydrated.owner = hydrated.owner || req.blog.id;
    hydrated.slug = hydrated.id.split(':').slice(1).join(':') || req.params.templateSlug || slug || "";

    const nameSource = hydrated.slug || req.params.templateSlug || "";

    if (!hydrated.name) {
      hydrated.name = nameSource
        ? nameSource[0].toUpperCase() + nameSource.slice(1).replace(/-/g, " ")
        : "";
    }

    if (!hydrated.id) {
      hydrated.id = Template.makeID(req.blog.id, hydrated.slug);
    }

    hydrated.locals = hydrated.locals || {};
    hydrated.partials = hydrated.partials || {};
    hydrated.previewPath = hydrated.previewPath || "";
    hydrated.isMine = hydrated.owner === req.blog.id;

    // locally edited templates are identified by their folder name
    hydrated.displayName = hydrated.localEditing ? hydrated.slug : hydrated.name;

    hydrated.checked = hydrated.id === req.blog.template ? "checked" : "";

    res.locals.templateMissing = templateMissing;

    req.template = res.locals.template = hydrated;

    res.locals.base = `${req.protocol}://${req.hostname}${req.baseUrl}/${req.params.templateSlug}`;
    // used to filter messages sent from the iframe which contains a preview of the
    // template in the template editor, such that we only save the pages which are
    // part of the template.
    res.locals.previewOrigin = `https://preview-of${
      hydrated.owner === req.blog.id ? "-my" : ""
    }-${hydrated.slug}-on-${req.blog.handle}.${config.host}`;
    // the preview iframe defaults to the template origin; the client stores
    // the most recent path in localStorage and applies it on load

    res.locals.preview = res.locals.previewOrigin;

    res.locals.breadcrumbs.add(hydrated.displayName, hydrated.slug);

    next();
  } catch (err) {
    console.error(err);
    next();
  }
};
