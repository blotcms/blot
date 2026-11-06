// Don't zoom images smaller than this
var MIN_WIDTH = 320;
var Url = require("url");
var fs = require("fs");
const withPluginCallback = require("../withPluginCallback");

async function render($) {
  $("img").each(function () {
    try {
      // Ignore img inside links
      if ($(this).parents("a").length) return;

      var src = $(this).attr("src");
      var width;

      width = $(this).attr("width") || $(this).attr("data-width");
      width = parseFloat(width);

      // Don't zoom images if they're tiny
      if (lacksZoomQuery(src) && width && width > MIN_WIDTH)
        $(this).attr("data-action", "zoom");
    } catch (e) {}
  });
}

function lacksZoomQuery(src) {
  var parsed;

  if (src.indexOf("?") === -1) return true;

  parsed = Url.parse(src);

  if (parsed && parsed.query && parsed.query.indexOf("zoom=false") > -1)
    return false;

  return true;
}

// The zoom script comes from the zoom-vanilla.js npm package (a dependency-free
// port of fat's zoom.js using the same data-action="zoom" and .zoom-* classes).
// It binds to document.body as soon as it runs, so defer it until the DOM is
// ready in case a template loads plugin JS in <head>. The sourceMappingURL
// comment is dropped since the map isn't served.
function publicJS() {
  var source = fs
    .readFileSync(require.resolve("zoom-vanilla.js"), "utf8")
    .replace(/^\/\/# sourceMappingURL=.*$/m, "");

  return (
    ";(function () {\n" +
    "var run = function () {\n" +
    source +
    "\n};\n" +
    "if (document.body) run();\n" +
    'else document.addEventListener("DOMContentLoaded", run);\n' +
    "})();\n"
  );
}

module.exports = {
  render: withPluginCallback(render),
  publicJS: publicJS(),
  isDefault: false,
  category: "images",
  title: "Zoomer",
  description: "Enable zoom on large images",
};
