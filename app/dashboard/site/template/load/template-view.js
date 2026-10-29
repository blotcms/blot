var Template = require("models/template");
var extname = require("path").extname;

module.exports = function (req, res, next) {
  if (req.params.viewSlug === "package.json") {
    const { views, template } = res.locals.getAllViews;

    req.view = res.locals.view = {
      content: Template.package.generate(req.blog.id, template, views),
      name: "package.json",
      isPackageJSON: true,
      editorMode: editorMode("package.json"),
    };

    return next();
  }

  Template.getView(req.template.id, req.params.viewSlug, function (err, view) {
    if (err || !view) return next(new Error("No view"));

    view.editorMode = editorMode(view.name);
    view.isPackageJSON = false;

    // HTML views can be opened on the template's preview host. Prefer a
    // concrete URL when a view has multiple configured URL patterns.
    if (extname(view.name).toLowerCase() === ".html" && res.locals.previewOrigin) {
      const configuredUrls = [
        ...(Array.isArray(view.urlPatterns) ? view.urlPatterns : []),
        ...(Array.isArray(view.url) ? view.url : [view.url]),
      ];
      const previewPath = configuredUrls.find(
        (url) =>
          typeof url === "string" &&
          url.startsWith("/") &&
          !url.startsWith("//") &&
          !/[:*()]/.test(url)
      );

      if (previewPath) {
        view.previewUrl = res.locals.previewOrigin + previewPath;
        view.outputUrl =
          view.previewUrl +
          (view.previewUrl.includes("?") ? "&" : "?") +
          "output=true";
        view.jsonUrl =
          view.previewUrl +
          (view.previewUrl.includes("?") ? "&" : "?") +
          "json=true";
      }
    }

    req.view = res.locals.view = view;
    next();
  });
};

// Determine the mode for the
// text editor based on the file extension
function editorMode(name) {
  var mode = "htmlmixed";

  if (extname(name) === ".js") mode = "javascript";

  if (extname(name) === ".json") mode = "javascript";

  if (extname(name) === ".css") mode = "css";

  if (extname(name) === ".txt") mode = "text";

  if (extname(name) === ".rss") mode = "xml";

  if (extname(name) === ".xml") mode = "xml";

  return mode;
}
