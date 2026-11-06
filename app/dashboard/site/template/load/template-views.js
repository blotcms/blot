var Template = require("models/template");
var arrayify = require("helper/arrayify");

module.exports = async function (req, res, next) {
  try {
    // getAllViews rejects when the template can't be read. That, like a
    // missing result, becomes "No template".
    var result = await Template.getAllViews(req.template.id).catch(() => null);
    var views = result && result.views;
    var template = result && result.metadata;

    if (!views || !template) return next(new Error("No template"));

    res.locals.getAllViews = { views, template };

    views = arrayify(views);

    // Hide readme files from the source list (but do not delete them)
    views = views.filter(function (view) {
      if (!view || !view.name) return true;
      var lower = String(view.name).toLowerCase();
      return (
        lower !== "readme" && lower !== "readme.md" && lower !== "readme.txt"
      );
    });

    views.push({ name: "package.json" });

    views.forEach(function (view) {
      if (req.params.viewSlug && view.name === req.params.viewSlug)
        view.selected = "selected";
      view.extension = {};
      var extension = view.name.split(".").pop().toLowerCase();
      view.extension[extension] = true;
      if (
        !["css", "html", "xml", "rss", "js", "json", "txt"].includes(extension)
      ) {
        view.extension.txt = true;
      }
      view.isPackageJSON = view.name === "package.json";
    });

    views = sort(views);
    res.locals.views = views;
  } catch (err) {
    return next(err);
  }

  next();
};

function sort(arr) {
  return arr.sort(function (a, b) {
    if (a.name < b.name) return -1;

    if (a.name > b.name) return 1;

    return 0;
  });
}
