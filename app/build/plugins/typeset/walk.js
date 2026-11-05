// Runs typeset's modules (quotes, smallCaps, punctuation, ...) over an HTML
// string, with the same results as typeset(html, options), but parsing the
// document once instead of once per module.
//
// typeset's own walker (typeset/src/eachTextNode) loads the whole document
// with cheerio for every enabled module and serializes it again after, which
// is five full parses and serializations per build with Blot's defaults. For
// each element it visits it also parses its ignore selector afresh
// ($(node).is(ignore)), and it replaces every text node by parsing the
// module's output as HTML, even when the module changed nothing. Together that
// was about half of the CPU time of a markdown build.
//
// Here the document is parsed once, with the cheerio typeset itself uses (so
// the DOM, and the serialized output, are the ones typeset would produce), and
// each module walks the DOM the previous one left, as it would have walked the
// re-parsed serialization of it. The ignore selector is compiled once, and a
// text node is only replaced when the module changed it into something that
// needs parsing.
const { dirname } = require("path");

const TYPESET_DIR = dirname(require.resolve("typeset/package.json"));
const CHEERIO_DIR = dirname(
  require.resolve("cheerio/package.json", { paths: [TYPESET_DIR] })
);
const cheerio = require(CHEERIO_DIR);
const select = require(require.resolve("css-select", { paths: [CHEERIO_DIR] }));

// Same order as typeset/src/index.js, which applies them in this order
const MODULES = [
  "quotes",
  "hyphenate",
  "ligatures",
  "smallCaps",
  "punctuation",
  "hangingPunctuation",
  "spaces",
].map((name) => ({
  name,
  // smallCaps: the same module with a constant built once (see ./smallCaps)
  fn: name === "smallCaps" ? require("./smallCaps") : require(TYPESET_DIR + "/src/" + name),
}));

// typeset/src/eachTextNode.js's default
const DEFAULT_IGNORE_SELECTORS =
  'head, code, pre, script, style, img, br, hr, [class^="pull-"], [class^="push-"], .small-caps';

const compiledIgnore = new Map();

function ignoreMatcher(ignore) {
  if (!compiledIgnore.has(ignore))
    compiledIgnore.set(ignore, select.compile(ignore));
  return compiledIgnore.get(ignore);
}

function isElement(node) {
  return node.type === "tag" || node.type === "script" || node.type === "style";
}

module.exports = function typeset(html, options = {}) {
  const modules = MODULES.filter(
    ({ name }) =>
      !(options.enable && !options.enable.includes(name)) &&
      !(options.disable && options.disable.includes(name))
  );

  if (!modules.length) return html;

  let ignore = DEFAULT_IGNORE_SELECTORS;
  if (options.ignore) ignore += ", " + options.ignore;
  const isIgnored = ignoreMatcher(ignore);

  const $ = cheerio.load(html, { decodeEntities: false });
  const root = $.root()[0];

  for (const { fn } of modules) {
    // typeset walks $(":root"): the top-level elements, so text outside any
    // element is left alone
    for (const node of root.children.slice()) {
      if (isElement(node)) walk(node, fn);
    }
  }

  return $.html();

  function walk(node, fn) {
    if (isElement(node) && isIgnored(node)) return;

    // A copy: replacing a child below changes the parent's list
    const children = node.children ? node.children.slice() : [];

    for (const child of children) {
      if (child.type !== "text") {
        walk(child, fn);
        continue;
      }

      let text = child.data;
      text = text.replace(/&#39;/g, "'");
      text = text.replace(/&quot;/g, '"');
      child.data = text;

      const output = fn(text, child, $);

      // Parsing text without markup gives back one text node with the same
      // data, so set it rather than parse it
      if (typeof output === "string" && output.indexOf("<") === -1) {
        if (output === "") $(child).remove();
        else child.data = output;
        continue;
      }

      $(child).replaceWith(output);
    }
  }
};
