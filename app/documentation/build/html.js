const cheerio = require("cheerio");
const pane = require("helper/pane");
const finder = require("../tools/finder");

// "Now" for the dates in the folder windows: one value per build process (this module is
// loaded once per build), so every page of a build agrees and the dates are as fresh as the
// deploy. See app/helper/pane/PLAN.md, "Fresh dates".
const BUILD_NOW = pane.isoNow();

// pane renders the folder and editor windows (pre.folder, pre.text, pre.code). Whatever it doesn't
// render yet (inline code.file / code.folder) is left for the old finder, which runs after it and so
// never sees the windows pane replaced. Retire the finder when pane covers all.
const windows = ($) => {
  pane.transform($, { now: BUILD_NOW });
  finder.html_parser($);
};

module.exports = async (contents) => {
  const transformers = [
    require("../tools/hljs"),
    require("../tools/typeset"),
    require("../tools/anchor-links"),
    require("../tools/tex"),
    windows,
  ];

  // we want to remove any indentation before the partial tag {{> body}}

  if (contents.includes("{{> body}}")) {
    const lines = contents.split("\n");
    const result = lines
      .map(i => {
        if (!i.includes("{{> body}}")) return i;
        if (i.trim().startsWith("{{> body}}")) return i.trim();
      })
      .join("\n");

    return result;
  }

  const $ = cheerio.load(contents, { decodeEntities: false }, false);

  for (const transformer of transformers) {
    transformer($);
  }

  let result = $.html();

  // replace all the escaped partial tags with the actual partial tags
  if (result.includes("{{&gt; ")) {
    result = result.replace(/{{&gt; /g, "{{> ");
  }

  // remove the indent from the line which contains the body partial
  // this prevents issues with code snippets
  if (result.includes("{{> body}}")) {
    const lines = result.split("\n");
    const index = lines.findIndex(line => line.includes("{{> body}}"));
    lines[index] = lines[index].trim();
    result = lines.join("\n");
  }
  
  return result;
};
