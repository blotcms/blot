const highlight = require("highlight.js");

// Language class names we recognise on <pre> (maps to hljs language ids)
const LANGUAGE_CLASSES = [
  "html",
  "xml",
  "javascript",
  "js",
  "json",
  "css",
  "markdown",
  "md",
  "yaml",
  "yml",
  "bash",
  "shell",
  "sh",
  "mustache",
  "handlebars",
];

function getLanguageFromClass(classAttr) {
  if (!classAttr || typeof classAttr !== "string") return null;
  const classes = classAttr.trim().split(/\s+/);
  for (const c of classes) {
    const lower = c.toLowerCase();
    if (LANGUAGE_CLASSES.includes(lower)) {
      // hljs uses "xml" not "html" for generic markup; "html" is valid
      if (lower === "md") return "markdown";
      if (lower === "yml") return "yaml";
      return lower;
    }
  }
  return null;
}

module.exports = function ($) {
  $("pre").each(function () {
    const $pre = $(this);
    const $code = $pre.children("code").first();
    if (!$code.length) return;

    const lang = getLanguageFromClass($pre.attr("class"));
    if (!lang) return;

    let code = $code.html();
    // Unescape entities that may have been encoded by cheerio/HTML
    code = code
      .split("&quot;")
      .join('"')
      .split("&lt;")
      .join("<")
      .split("&gt;")
      .join(">")
      .split("&amp;")
      .join("&");

    let highlighted;
    try {
      highlighted = highlight.highlight(lang, code).value;
    } catch (e) {
      return; // leave block as-is if language not supported or highlight fails
    }

    $code.addClass("hljs").html(highlighted);
  });
};
