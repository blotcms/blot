var mustache = require("mustache");
var highlight = require("highlight.js");
var template_directory = __dirname + "/templates";

module.exports = function render_code_editor(code, classes, title) {
  code = code.split("&quot;").join('"');
  code = highlight.highlight("html", code).value;
  code = code.split("&amp;apos;").join("'");
  var lines = [];
  while (lines.length < code.split("\n").length + 1)
    lines.push({ number: lines.length + 1 });

  return mustache.render(
    require("fs-extra").readFileSync(
      template_directory + "/code-editor.mustache",
      "utf8"
    ),
    {
      code: code,
      lines: lines,
      classes: classes.map(function (c) {
        return { class: c };
      }),
      title: title || "Code",
    }
  );
};
