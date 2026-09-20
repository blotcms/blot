// Builds the one stylesheet a page ships (see DESIGN.md §2). Pure: a function of the
// files in css/ and icons/ and the options, cached by the caller.
//
// A skin file (css/mac.css) is ordinary CSS plus two directives:
//   @light{ --token:value; ... }   the tokens for the light scheme
//   @dark{ --token:value; ... }    the tokens for dark (may also hold rules, which are
//                                  emitted for dark only)
// and every rule is written against `.pane` (the window itself). The build wraps that
// root so the rule applies to windows following the visitor's OS (html[data-os]) and to
// windows pinned to that OS (data-pin), never both:
//   :is(html[data-os=mac] .pane:not([data-pin]),.pane[data-pin=mac])
// The default skin also applies while <html> has no data-os (no JS).
// url(icon:mac/folder) inlines icons/mac/folder.svg as a data URI.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SKINS = ["mac"]; // win and linux land with their skins
const DEFAULT_SKIN = "mac";

// Splits CSS into top-level items: { sel, body } for a block, { text } for a statement.
function items(css) {
  const out = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    const semi = css.indexOf(";", i);
    if (open === -1 || (semi !== -1 && semi < open)) {
      const end = semi === -1 ? css.length : semi + 1;
      if (css.slice(i, end).trim()) out.push({ text: css.slice(i, end).trim() });
      i = end;
      continue;
    }
    let depth = 1;
    let j = open + 1;
    while (depth && j < css.length) depth += css[j] === "{" ? 1 : css[j] === "}" ? -1 : 0, j++;
    out.push({ sel: css.slice(i, open).trim(), body: css.slice(open + 1, j - 1) });
    i = j;
  }
  return out;
}

const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

const minify = (css) =>
  strip(css)
    .replace(/\s+/g, " ")
    .replace(/\s*([{};,>])\s*/g, "$1")
    .replace(/:\s+/g, ":")
    .replace(/;}/g, "}")
    .trim();

// what the skin's rules apply to: the windows of that skin
const group = (os) =>
  `:is(html[data-os=${os}] .pane:not([data-pin]),.pane[data-pin=${os}]${os === DEFAULT_SKIN ? ",html:not([data-os]) .pane:not([data-pin])" : ""})`;

// Replaces the leading `.pane` of each selector in a comma list; `extra` is appended to
// the root (theme qualifiers).
function root(sel, os, extra = "") {
  return sel
    .split(",")
    .map((s) => {
      s = s.trim();
      if (!/^\.pane(?![\w-])/.test(s)) throw new Error(`skin selector must start with .pane: ${s}`);
      return group(os) + extra + s.slice(5);
    })
    .join(",");
}

// Rules (possibly inside @container / @media) with every selector rooted.
function rootRules(css, os, extra) {
  return items(css)
    .map((it) => {
      if (it.text) return it.text;
      if (it.sel.startsWith("@")) return `${it.sel}{${rootRules(it.body, os, extra)}}`;
      return `${root(it.sel, os, extra)}{${it.body}}`;
    })
    .join("");
}

function icons(css) {
  return css.replace(/url\(icon:([\w/-]+)\)/g, (m, name) => {
    const svg = fs.readFileSync(path.join(ROOT, "icons", `${name}.svg`), "utf8").trim().replace(/\s+/g, " ").replace(/> </g, "><");
    return `url("data:image/svg+xml,${svg.replace(/"/g, "'").replace(/%/g, "%25").replace(/</g, "%3C").replace(/>/g, "%3E").replace(/#/g, "%23")}")`;
  });
}

// One skin file -> plain CSS.
function skin(os, source) {
  let rules = "";
  let light = "";
  let dark = "";
  for (const it of items(strip(source))) {
    if (it.sel === "@light") light += it.body;
    else if (it.sel === "@dark") dark += it.body;
    else rules += it.text || `${it.sel}{${it.body}}`;
  }
  const scheme = (tokens, name) => (tokens ? `${tokens};color-scheme:${name}` : "");
  // dark: the tokens (declarations) and any rules
  const decls = [];
  const darkRules = [];
  for (const it of items(dark)) {
    if (it.sel) darkRules.push(`${it.sel}{${it.body}}`);
    else decls.push(it.text);
  }
  const tokens = decls.join("");
  const asDark = (extra) => (tokens ? `${root(".pane", os, extra)}{${scheme(tokens, "dark")}}` : "") + darkRules.map((r) => rootRules(r, os, extra)).join("");
  return [
    light && `${root(".pane", os)}{${scheme(light, "light")}}`,
    rootRules(rules, os),
    tokens || darkRules.length ? `@media (prefers-color-scheme:dark){${asDark(":not([data-theme=light])")}}` : "",
    asDark("[data-theme=dark]"),
  ].join("");
}

function build(options = {}) {
  const skins = options.skins || SKINS;
  const read = (f) => fs.readFileSync(path.join(ROOT, "css", f), "utf8");
  // prose: <span class="pane-name"> shows the child for the visitor's OS (or the default)
  const prose = skins.map((os) => `html[data-os=${os}] .pane-name>[data-os=${os}]${os === DEFAULT_SKIN ? `,html:not([data-os]) .pane-name>[data-os=${os}]` : ""}`).join(",") + "{display:inline}";
  const css = read("base.css") + skins.map((os) => skin(os, read(`${os}.css`))).join("") + prose;
  return minify(icons(css));
}

module.exports = { build, skin, minify, items, root, group, SKINS, DEFAULT_SKIN };
