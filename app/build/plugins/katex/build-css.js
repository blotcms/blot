// Writes Blot's copies of KaTeX's stylesheet from the installed katex package.
// Run it after bumping katex: node app/build/plugins/katex/build-css.js
//
// KaTeX 0.18 prefixed twenty of its internal classes (base became
// katex-base, strut katex-strut, ...). Entries keep the HTML they were built
// with, so posts built before the bump still use the old names. Each copy
// below is KaTeX's own CSS followed by its rules for the renamed classes
// again under the old names, so math renders the same whichever KaTeX built
// the post.
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../../../..");

// The classes KaTeX 0.18 renamed to katex-<name>
const RENAMED = [
  "accent",
  "base",
  "fix",
  "hdashline",
  "hline",
  "inner",
  "newline",
  "overlay",
  "overline",
  "root",
  "rule",
  "sizing",
  "smash",
  "sout",
  "stretchy",
  "strut",
  "tag",
  "thinbox",
  "underline",
  "vbox",
];

// Where each copy lives, the path it serves KaTeX's fonts from and whether
// to write one rule per line, for a copy people read and edit
const OUTPUTS = [
  // Appended to blogs' stylesheets by {{{app_css}}}
  ["app/build/plugins/katex/public.css", "/plugins/katex/files/", false],
  // The Magazine template's own copy
  [
    "app/templates/source/magazine/css-katex.css",
    "/plugins/katex/files/",
    true,
  ],
  // The documentation's math (app/documentation/tools/tex.js)
  ["app/views/css/tex.css", "/katex/", false],
];

const RENAMED_CLASS = new RegExp(
  "\\.katex-(" + RENAMED.join("|") + ")(?![\\w-])",
  "g"
);

// The rules that use a renamed class, with the old names instead. KaTeX's
// minified CSS has no nesting other than @font-face, which never matches.
function legacyRules(css) {
  const rules = [];
  for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (selectors.trim().startsWith("@")) continue;
    const legacy = selectors
      .split(",")
      .filter((selector) => selector.match(RENAMED_CLASS))
      .map((selector) => selector.replace(RENAMED_CLASS, ".$1"));
    if (legacy.length) rules.push(legacy.join(",") + "{" + body + "}");
  }
  return rules.join("");
}

function build() {
  const css = fs.readFileSync(
    require.resolve("katex/dist/katex.min.css"),
    "utf8"
  );
  const legacy = legacyRules(css);
  if (!legacy) throw new Error("No renamed KaTeX classes found");

  for (const [file, fonts, perLine] of OUTPUTS) {
    let out = (css.trim() + legacy).replace(/url\(fonts\//g, "url(" + fonts);
    if (perLine) out = out.replace(/\}/g, "}\n");
    fs.writeFileSync(path.join(ROOT, file), out);
  }
}

if (require.main === module) build();

module.exports = { build, legacyRules, RENAMED };
