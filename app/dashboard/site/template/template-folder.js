const config = require("config");
const Template = require("models/template");
const makeSlug = require("helper/makeSlug");

// Renders Blot's own, unmodified copy of a default template — reachable at
// /template-folder/:slug, a sibling of /template/:slug (see
// app/dashboard/site/index.js), instead of nested under it, because
// /template/:slug always resolves to the blog's own copy once one exists
// (see ./load/template.js), so it can't show the original once a
// localEditing fork of it exists. This page is read-only: to change
// anything, use the fork it links to (or Duplicate, from the normal
// /template/:slug page, before a fork exists).
module.exports = function (req, res, next) {
  const slug = makeSlug(req.params.templateFolderSlug);
  // Mounted as a sibling of /template, not nested inside it, so
  // req.baseUrl is "/sites/:handle" here — append the mount /template itself
  // handles.
  const dashboardBase = `${req.protocol}://${req.hostname}${req.baseUrl}/template`;

  Template.getMetadata(Template.makeID("SITE", slug), (err, template) => {
    if (err) return next(err);
    if (!template) return next();

    Template.getMetadata(Template.makeID(req.blog.id, slug), (err, fork) => {
      if (err) return next(err);

      // Nothing to disambiguate: without a localEditing fork at this slug,
      // /template/:slug already shows this exact template (see
      // ./load/template.js), so send the visitor there instead of showing
      // them a second, read-only copy of the same page.
      if (!fork || !fork.localEditing) {
        return res.redirect(`${dashboardBase}/${slug}`);
      }

      res.locals.title = `${template.name} - Templates`;
      res.locals.dashboardBase = dashboardBase;
      res.locals.templateFolder = {
        name: template.name,
        checked: template.id === req.blog.template,
        previewURL: `https://preview-of-${slug}-on-${req.blog.handle}.${config.host}`,
        fork: { slug: fork.id.split(":").slice(1).join(":") },
      };

      res.render("dashboard/template/template-folder");
    });
  });
};
