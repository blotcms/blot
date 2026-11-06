var Express = require("express");
var developers = new Express.Router();
var makeSlug = require("helper/makeSlug");
const { marked } = require("marked");

developers.use(function (req, res, next) {
  res.locals.base = "/developers";
  // Override breadcrumb labels that mean something different in developer docs
  if (res.locals.breadcrumbs) {
    const LABELS_IN_DEVELOPERS = { examples: "Examples" };
    res.locals.breadcrumbs.forEach((crumb) => {
      const slug = crumb.url.split("/").filter(Boolean).pop();
      if (LABELS_IN_DEVELOPERS[slug]) crumb.label = LABELS_IN_DEVELOPERS[slug];
    });
  }
  // Show table of contents on developer doc subpages: get-started, guides, guides/*, reference, examples, troubleshooting
  if (req.path !== "/") res.locals["show-toc"] = true;
  next();
});

developers.get(["/reference"], function (req, res, next) {
  res.locals["show-on-this-page"] = true;

  res.locals.docs = require("yaml").parse(
    require("fs-extra").readFileSync(
      __dirname + "/../views/developers/reference.yml",
      "utf-8"
    )
  );

  // Render the descriptions as markdown
  res.locals.docs.forEach((section) => {
    section.keys.forEach((property) => {
      const { description, properties } = property;

      if (description) {
        property.description = marked.parse(description);
      }

      if (properties) {
        property.properties = properties.map((property) => {
          property.description = marked.parse(property.description);
          return property;
        });
      }
    });
  });

  res.locals.headers = res.locals.docs.map((item) => {
    return { text: item.name, id: makeSlug(item.name) };
  });

  res.locals.headers.push({ text: "Date tokens", id: "date-tokens" });

  // These interfere with the reference template
  // if we rename the reference template, you can
  // remove these lines
  delete res.locals.selected.reference;
  delete res.locals.selected.referenceIndex;
  next();
});

developers.get("/", function (req, res) {
  res.locals.title = "Developers";
  res.render("developers");
});

module.exports = developers;
