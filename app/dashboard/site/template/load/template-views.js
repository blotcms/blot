var Template = require("models/template");
var arrayify = require("helper/arrayify");

module.exports = function (req, res, next) {
  Template.getAllViews(req.template.id, function (err, views, template) {
    if (err || !views || !template) return next(new Error("No template"));

    res.locals.getAllViews = { views, template };

    views = arrayify(views);

    // Hide readme files from the source list (but do not delete them)
    views = views.filter(function (view) {
      if (!view || !view.name) return true;
      var lower = String(view.name).toLowerCase();
      return (
        lower !== "readme" &&
        lower !== "readme.md" &&
        lower !== "readme.txt"
      );
    });

    views.push({ name: "package.json" });

    views.forEach(function (view) {
      if (req.params.viewSlug && view.name === req.params.viewSlug)
        view.selected = "selected";
      view.extension = {};
      var extension = view.name.split(".").pop().toLowerCase();
      view.extension[extension] = true;
      if (!["css", "html", "xml", "rss", "js", "json", "txt"].includes(extension)) {
        view.extension.txt = true;
      }
      view.isPackageJSON = view.name === "package.json";
    });

    views = sort(views);
    res.locals.views = views;

    next();
  });
};

function sort(arr) {
  return arr.sort(function (a, b) {
    if (a.name < b.name) return -1;

    if (a.name > b.name) return 1;

    return 0;
  });
}
