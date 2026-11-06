var mustache = require("mustache");
var template_directory = __dirname + "/templates";

module.exports = function render_text_editor(text, classes, title) {
  return mustache.render(
    require("fs-extra").readFileSync(
      template_directory + "/text-editor.mustache",
      "utf8"
    ),
    {
      text: text,
      classes: classes.map(function (c) {
        return { class: c };
      }),
      title: title || "Text",
    }
  );
};
