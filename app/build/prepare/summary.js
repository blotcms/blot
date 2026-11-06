var debug = require("debug")("blot:build:prepare:summary");

var puncs = "?.!:,".split("");
var MAX_LENGTH = 150;
var he = require("he");

// since the summary is often used
// {{}} which is encoded by mustache
// we have to decode it in advance
// because the HTML has already been
// decoded by pandoc...!
function normalize(str) {
  return he.decode(str).replace(/\s/g, " ").trim();
}

function summary($, title) {
  var summary;

  // Serializing the document costs as much as parsing it: only when logging
  if (debug.enabled) debug($.html());

  // We ignore the text content of
  // these tags for the summary
  // we only care about the content
  // of parapgraph tags for summaries
  // but these could sneak in
  // we allow code but not code – this means
  // that the text of inline code snippets is included:
  // e.g.  `here` in the paragraph but block code is not:
  // ```
  // will be exluded
  // ```
  $(
    "pre, .katex, script, object, iframe, style, h1, h2, h3, h4, h5, h6, img + .caption"
  ).remove();

  // add a space before the end of
  // each node so newlines look ok
  $("p, blockquote").each(function () {
    $(this).append(" ");
  });

  title = normalize(title);
  summary = normalize($(":root").text());

  if (summary.length > MAX_LENGTH) {
    summary = summary.slice(0, MAX_LENGTH);
    summary = summary.trim();

    // and go to last whole word
    // what if its the only word?
    while (summary.indexOf(" ") > -1 && summary.slice(-1) !== " ")
      summary = summary.slice(0, -1);
  }

  // Entries without titles will
  // have duplicate summaries
  if (summary && title && summary.indexOf(title) === 0) {
    summary =
      summary.slice(title.length, title.length + MAX_LENGTH).trim() || "";
  }

  // Remove any trailing puntuation
  while (summary && summary.length && puncs.indexOf(summary.slice(-1)) > -1)
    summary = summary.slice(0, -1) || "";

  // Remove any leading punctuation
  while (summary && summary.length && puncs.indexOf(summary.charAt(0)) > -1)
    summary = summary.slice(1) || "";

  summary = summary.trim();

  debug(summary);

  return summary;
}

module.exports = summary;
