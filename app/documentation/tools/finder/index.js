var render_folder = require("./render_folder");
var render_text_editor = require("./render_text_editor");
var render_code_editor = require("./render_code_editor");
var extension = require("./determine_icon");

function middleware(req, res, next) {
  var send = res.send;

  res.send = function (string) {
    req.trace("starting finder render");

    var body = string instanceof Buffer ? string.toString() : string;

    // console.time('Rendering finder');
    body = html_parser(body);
    // console.timeEnd('Rendering finder');

    req.trace("finished finder render");
    send.call(this, body);
  };

  next();
}

function html_parser($) {
  $("code.file, code.folder").each(function (i, el) {
    var text = $(el).html().trim();
    var type =
      $(el).attr("class").split("file").join("").trim() || extension(text);

    $(el).replaceWith(
      '<nobr><span class="icon ' + type + '"></span> ' + text + "</nobr>"
    );
  });

  $("pre.folder, pre.text, pre.code").each(function (i, el) {
    var source = $(el).find("code").length ? $(el).find("code").first() : $(el);
    var classes = $(el).attr("class") || "";
    var title = $(el).attr("title") || "";

    title = title.trim();
    classes = classes.trim().split(" ");

    var renderer;

    if ($(el).hasClass("text")) renderer = render_text_editor;
    if ($(el).hasClass("code")) renderer = render_code_editor;
    if ($(el).hasClass("folder")) renderer = render_folder;

    if (!renderer) return;

    var html = renderer(source.html(), classes, title);

    $(el).replaceWith(html);
  });
}

module.exports = {
  middleware: middleware,
  html_parser: html_parser,
  css: require("./build"),
};
