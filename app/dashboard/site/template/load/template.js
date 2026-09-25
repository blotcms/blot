var config = require("config");
var Template = require("models/template");
var makeSlug = require("helper/makeSlug");

const getMetadata = (templateID) => {
  return new Promise((resolve, reject) => {
    Template.getMetadata(templateID, (err, template) => {
      if (err || !template) return resolve(null);
      resolve(template);
    });
  });
};

// /template and /template-folder mount the same router (see
// app/dashboard/site/index.js) — a template the blog has moved into its
// local editing folder is only ever reached at /template-folder/:slug, and
// /template/:slug shows the SITE-owned template it was forked from instead,
// even though both slugs otherwise resolve to the same template metadata.
// Without this, both mounts would show (and a POST would act on) whichever
// one the blog owns, since that's normally preferred — silently doing
// settings, delete, rename, reset, duplicate or install against the wrong
// one depending on which row in the sidebar happened to link where.
const loadTemplate = async (blogID, templateSlug, onFolderMount) => {
  const slug = makeSlug(templateSlug);
  const blogTemplate = await getMetadata(Template.makeID(blogID, slug));
  const defaultTemplate = await getMetadata(Template.makeID("SITE", slug));
  const hasFolderFork = !!(blogTemplate && blogTemplate.localEditing);

  if (onFolderMount) {
    // Nothing to show here without an actual folder copy; the caller
    // redirects to /template/:slug instead of falling through to it. Still
    // mark it a mirror of the SITE template it was forked from, same as any
    // other fork, so the settings page offers "Reset changes" rather than
    // "Delete" for it.
    if (!hasFolderFork) return null;
    if (defaultTemplate) blogTemplate.isMirror = true;
    return blogTemplate;
  }

  if (hasFolderFork && defaultTemplate) {
    // The blog's copy lives at /template-folder/:slug now; this URL shows
    // the SITE original it was forked from, not a mirror of the fork.
    return defaultTemplate;
  }

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

module.exports = async function (req, res, next) {
  try {
    const slug = makeSlug(req.params.templateSlug);
    const onFolderMount = /\/template-folder$/.test(req.baseUrl);

    const template = await loadTemplate(req.blog.id, slug, onFolderMount);

    if (onFolderMount && !template) {
      const newBaseUrl = req.baseUrl.replace(/\/template-folder$/, "/template");
      return res.redirect(newBaseUrl + req.originalUrl.slice(req.baseUrl.length));
    }

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
