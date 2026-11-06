var arrayify = require("helper/arrayify");
var previewHost = "https://preview-of";
var config = require("config");
var Template = require("models/template");
var screenshots = require("./screenshots");

// Adds the URLs and labels the dashboard shows for a template
function decorate(template, req, res) {
  var blog = req.blog;
  var currentTemplate = blog.template;
  var cdn = typeof res.locals.cdn === "function" ? res.locals.cdn() : null;

  // /template and /template-folder both mount this same router (see
  // app/dashboard/site/index.js) — express.Router sets req.baseUrl to
  // whichever prefix actually matched, so this tells the two apart without
  // needing a different param name or resolution rule for either.
  var onFolderMount = /\/template-folder$/.test(req.baseUrl);

  template.nameLower = template.name.toLowerCase();

  if (template.owner === blog.id) template.isMine = true;

  // The blog's own copy of one of Blot's default templates, so the list can
  // tell it apart from the default it was made from
  template.isCopyOfDefault =
    template.owner === blog.id &&
    !!template.cloneFrom &&
    template.cloneFrom.startsWith("SITE:");

  if (template.id === currentTemplate) template.checked = "checked";

  var mySubDomain = template.isMine ? "my-" : "";

  // remap the slug to be everything after the first colon in the ID
  template.slug = template.id.split(":").slice(1).join(":");

  // A template moved into the blog's local editing folder gets its own
  // URL under /template-folder/ instead of /template/ — otherwise it'd
  // share a slug (and a URL, since /template/:slug prefers the blog's
  // own copy once one exists) with the SITE-owned template it was
  // forked from, and the sidebar couldn't tell which row was open.
  var inFolder = template.isMine && template.localEditing;

  template.editURL = inFolder
    ? "/sites/" + blog.handle + "/template-folder/" + template.slug
    : "/sites/" + blog.handle + "/template/" + template.slug;

  template.selected =
    req.path.split("/")[1] === template.slug && onFolderMount === !!inFolder
      ? "selected"
      : "";

  // Todo replace the thumbnail with a real thumbnail of the template
  if (template.owner === blog.id) {
    if (template.cloneFrom && template.cloneFrom.startsWith("SITE:")) {
      if (template.slug.indexOf("-copy") !== -1) {
        template.thumbnailSlug = template.slug.split("-copy")[0];
      } else {
        template.thumbnailSlug = "index";
      }
    } else {
      template.thumbnailSlug = "index";
    }
  } else {
    template.thumbnailSlug = template.slug;
  }

  var thumbnailPath = `/images/examples/${template.thumbnailSlug}/0-thumb.png`;
  template.thumbnailURL = cdn
    ? cdn(thumbnailPath, (path) => path)
    : thumbnailPath;

  template.previewURL =
    previewHost +
    "-" +
    mySubDomain +
    template.slug +
    "-on-" +
    blog.handle +
    "." +
    config.host +
    "?screenshot=true";

  template.previewMenuURL =
    previewHost +
    "-" +
    mySubDomain +
    template.slug +
    "-on-" +
    blog.handle +
    "." +
    config.host;

  return template;
}

module.exports = async function (req, res, next) {
  var blog = req.blog,
    blogID = blog.id,
    currentTemplate = blog.template;

  try {
    let templates = await Template.getTemplateList(blogID);
    var yourTemplates = [];
    var blotTemplates = [];

    // Turn the dictionary of templates returned
    // from the DB into a list that Mustache can render
    templates = arrayify(templates, function (template) {
      decorate(template, req, res);

      if (template.owner === blogID) yourTemplates.push(template);

      if (template.owner !== blogID) blotTemplates.push(template);
    });

    // A template of the blog's with the slug of a default one is a copy of it
    // too, even without cloneFrom (e.g. one created in the local folder)
    var defaultSlugs = {};
    blotTemplates.forEach(function (template) {
      defaultSlugs[template.slug.toLowerCase()] = true;
    });
    yourTemplates.forEach(function (template) {
      if (defaultSlugs[template.slug.toLowerCase()])
        template.isCopyOfDefault = true;
    });

    // if there are two templates with the same slug and the same name, hide the template owned by 'SITE'
    // so only the template owned by the blog is shown
    // use reduce to filter out the duplicate templates
    templates = templates.reduce(function (acc, template) {
      // ensure that the template owned by the blog id is in the list
      // rather than the template owned by 'SITE' if there are two templates
      const targetTemplate = acc.find(
        (t) => t.slug === template.slug && t.name === template.name
      );

      if (
        targetTemplate &&
        !targetTemplate.localEditing &&
        !template.localEditing
      ) {
        // if the template is owned by the blog id, replace the template owned by 'SITE'
        // with the template owned by the blog id and also set the property
        if (template.owner === blogID && !template.localEditing) {
          // A default template whose settings this blog changed: the edits
          // live in the blog's own copy, shown in the default's place
          template.isMine = false;
          template.isMirror = true;
          template.isCopyOfDefault = false;
          return acc.filter((t) => t.slug !== template.slug).concat(template);
        } else {
          return acc;
        }
      }

      return acc.concat(template);
    }, []);

    // Sort templates alphabetically,
    // with my templates above site tmeplates
    templates.sort(function (a, b) {
      if (a.isMine && !b.isMine) return -1;

      if (b.isMine && !a.isMine) return 1;

      var aName = a.name.trim().toLowerCase();

      var bName = b.name.trim().toLowerCase();

      if (aName < bName) return -1;

      if (aName > bName) return 1;

      return 0;
    });

    templates.forEach(function (template) {
      var isOpenInEditor = !!template.selected;

      template.switcherClass = isOpenInEditor
        ? "site-switcher__site is-current"
        : "site-switcher__site";
      template.isOpenInEditor = isOpenInEditor;
      template.switcherSubtext = template.checked
        ? "Live on your site"
        : template.isMirror
          ? "Customized"
          : template.owner === blogID
            ? template.isCopyOfDefault
              ? "Your copy"
              : "Your template"
            : "Default template";
    });

    // The template list's filter pills and card styles
    templates.forEach(function (template) {
      template.filterType = template.isMine ? "yours" : "default";
      template.cardClass = template.checked
        ? "template-card is-live"
        : "template-card";
    });

    res.locals.templateSwitcherTemplates = templates;

    res.locals.yourTemplates = templates.filter(
      (template) => template.isMine && !template.localEditing
    );

    res.locals.templatesInYourFolder = templates.filter(
      (template) => template.isMine && template.localEditing === true
    );

    res.locals.customTemplates = res.locals.yourTemplates
      .concat(res.locals.templatesInYourFolder)
      .filter((template) => template.id !== currentTemplate);

    res.locals.blotTemplates = templates.filter((template) => !template.isMine);

    res.locals.defaultTemplates = res.locals.blotTemplates.filter(
      (template) => template.id !== currentTemplate
    );

    res.locals.currentTemplate = templates.filter(
      (template) => template.id === currentTemplate
    )[0];

    // Screenshots of the blog's own templates, taken in the background
    await screenshots.decorate(blog, templates, { complete: true });
    next();
  } catch (err) {
    next(err);
  }
};

// Redirects to a template's current screenshot, or its gallery image while
// it has none. The template list's images load through this, so a page can
// ask again and get a screenshot finished since it was rendered.
module.exports.screenshot = function (req, res, next) {
  if (!req.template) return next();

  const template = decorate(req.template, req, res);

  screenshots
    .current(req.blog.id, template.id)
    .then(function (url) {
      res.set("Cache-Control", "no-cache");
      res.redirect(302, url || template.thumbnailURL);
    })
    .catch(next);
};
