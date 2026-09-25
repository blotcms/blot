var arrayify = require("helper/arrayify");
var previewHost = "https://preview-of";
var config = require("config");
var Template = require("models/template");

module.exports = function (req, res, next) {
  var blog = req.blog,
    blogID = blog.id,
    currentTemplate = blog.template;

  Template.getTemplateList(blogID, function (err, templates) {
    var yourTemplates = [];
    var blotTemplates = [];

    // Slugs the blog has its own localEditing copy of. A SITE-owned template
    // at one of these slugs is still shown alongside that copy in the
    // sidebar (see the dedup step below), but /template/<slug> always
    // resolves to the blog's copy once one exists, so the SITE row needs a
    // URL of its own to stay reachable and to highlight independently. See
    // ./template-folder.js.
    var localEditingSlugs = {};
    for (var templateID in templates) {
      var t = templates[templateID];
      if (t.owner === blogID && t.localEditing) {
        localEditingSlugs[t.id.split(":").slice(1).join(":")] = true;
      }
    }

    // Turn the dictionary of templates returned
    // from the DB into a list that Mustache can render
    templates = arrayify(templates, function (template) {
      template.nameLower = template.name.toLowerCase();

      if (template.owner === blog.id) template.isMine = true;

      if (template.id === currentTemplate) template.checked = "checked";

      var mySubDomain = template.isMine ? "my-" : "";

      // remap the slug to be everything after the first colon in the ID
      template.slug = template.id.split(':').slice(1).join(':');

      var inFolder = template.owner === "SITE" && localEditingSlugs[template.slug];
      template.isTemplateFolder = !!inFolder;
      var pathParts = req.path.split("/");

      template.selected = inFolder
        ? pathParts[1] === "template-folder" && pathParts[2] === template.slug
          ? "selected"
          : ""
        : pathParts[1] === template.slug
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

      template.editURL = inFolder
        ? "/sites/" + blog.handle + "/template-folder/" + template.slug
        : "/sites/" + blog.handle + "/template/" + template.slug;

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

      if (template.owner === blogID) yourTemplates.push(template);

      if (template.owner !== blogID) blotTemplates.push(template);
    });

    // if there are two templates with the same slug and the same name, hide the template owned by 'SITE'
    // so only the template owned by the blog is shown
    // use reduce to filter out the duplicate templates
    templates = templates.reduce(function (acc, template) {
      // ensure that the template owned by the blog id is in the list
      // rather than the template owned by 'SITE' if there are two templates
      const targetTemplate = acc.some((t) => t.slug === template.slug && t.name === template.name);

      if (targetTemplate && !targetTemplate.localEditing && !template.localEditing) {
        // if the template is owned by the blog id, replace the template owned by 'SITE'
        // with the template owned by the blog id and also set the property
        if (template.owner === blogID && !template.localEditing) {
          template.isMine = false;
          template.isMirror = true;
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

    res.locals.yourTemplates = templates.filter(
      (template) =>
        template.isMine && !template.localEditing
    );

    res.locals.templatesInYourFolder = templates.filter(
      (template) =>
        template.isMine && template.localEditing === true
    );

    res.locals.blotTemplates = templates.filter(
      (template) => !template.isMine 
    );

    res.locals.currentTemplate = templates.filter(
      (template) => template.id === currentTemplate
    )[0];
    
    next();
  });
};
