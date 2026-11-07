// typeset(html, options), parsing the document once: see ./walk
var typeset = require("./walk");

function normalizeBooleanOption(value) {
  if (value === null || value === undefined || value === false || value === 0)
    return false;

  if (value === true || value === 1) return true;

  if (typeof value === "string") {
    var normalized = value.trim().toLowerCase();

    if (
      normalized === "" ||
      normalized === "false" ||
      normalized === "off" ||
      normalized === "0"
    )
      return false;

    if (normalized === "true" || normalized === "on" || normalized === "1")
      return true;
  }

  return Boolean(value);
}

async function prerender(html, options) {
  // would be nice to add options. hyphenate in future
  // but it fucks with automatic image links and automatic
  // video links since the contents of the link don't match
  // the href property due to insertion of soft hyphens...

  // Pandoc does a lot of this shit too

  var disable = ["ligatures", "hyphenate"];

  options.spaces = options.quotes = options.punctuation;

  for (var i in options)
    if (!normalizeBooleanOption(options[i])) disable.push(i);

  try {
    // we don't want to process the contents of katex math blocks
    // fenced with dollar signs otherwise we run into a variety of bugs
    html = typeset(html, { disable: disable, ignore: ["span.math"] });
  } catch (e) {}

  return html;
}

module.exports = {
  prerender,
  category: "Typography",
  title: "Substitution",
  description: "Correct common typographic errors",
  options: {
    hangingPunctuation: true,
    punctuation: true,
    smallCaps: true,
  },
};
