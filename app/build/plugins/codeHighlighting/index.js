const he = require("he");
const hljs = require("highlight.js");
const withPluginCallback = require("../withPluginCallback");

async function render($) {
  $("pre code").each(function () {
    try {
      var lang = $(this).parent().attr("class").split(" ")[0];

      if (!lang) return;

      var code = $(this).text();

      var highlighted = highlight(code, lang);

      $(this).html(highlighted).addClass("hljs").addClass(lang);

      $(this).parent().removeClass(lang);

      // hmmm...
      if (!$(this).parent().attr("class").trim())
        $(this).parent().attr("class", null);
    } catch (e) {}
  });
}

function highlight(code, lang) {
  // For some reason highlight
  // doesn't play nicely with already-decoded
  // apostrophes like ' &#84; etc...
  code = he.decode(code);

  return hljs.highlight(lang, code).value;
}

module.exports = {
  category: "codemath",
  title: "Code",
  render: withPluginCallback(render),
  description: "Highlight code syntax",
};
