// Build-time syntax highlighting for the code editor window. highlight.js is an optional
// dependency: without it (or for an unknown language) the code is plain escaped text, with a
// warning, never an error. Output is one HTML string per source line, so the markup can wrap
// each line in its own span (the line-number gutter is CSS counters over those spans) and no
// token span crosses a line break.
//
// Token classes are short (`pane-t-k`, ...) and few: a skin colours them through the custom
// properties --tok-k, --tok-s, ... (DESIGN.md "Editor windows"). This table maps highlight.js
// scopes to them; a scope that isn't listed is dropped (its text stays).

const TOKENS = {
  keyword: "k",
  "selector-tag": "k",
  doctag: "k",
  string: "s",
  regexp: "s",
  "template-tag": "s",
  comment: "c",
  quote: "c",
  number: "n",
  literal: "n",
  bullet: "n",
  title: "f",
  function: "f",
  section: "f",
  attr: "a",
  attribute: "a",
  property: "a",
  "selector-attr": "a",
  tag: "t",
  name: "t",
  "selector-id": "t",
  "selector-class": "t",
  meta: "m",
  "meta-keyword": "m",
  "meta-string": "m",
  type: "y",
  class: "y",
  built_in: "y",
  variable: "v",
  "template-variable": "v",
  symbol: "v",
  params: "v",
};
const TOKEN_CLASSES = ["k", "s", "c", "n", "f", "a", "t", "m", "y", "v"];

const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

let hljs; // undefined: not tried; null: unavailable
let warned = false;
function load() {
  if (hljs !== undefined) return hljs;
  try {
    hljs = require("highlight.js");
  } catch (e) {
    hljs = null;
    if (!warned) {
      warned = true;
      console.warn("pane: highlight.js is not available; code windows show plain text");
    }
  }
  return hljs;
}

// hljs 11 takes (code, { language }); 10 takes (language, code, ignoreIllegals)
function run(lib, language, code) {
  const major = parseInt(String(lib.versionString || "10").split(".")[0], 10);
  return (major >= 11 ? lib.highlight(code, { language, ignoreIllegals: true }) : lib.highlight(language, code, true)).value;
}

// "plain" | a language highlight.js knows | null (unknown)
function resolve(language) {
  const name = String(language || "html").toLowerCase().trim();
  if (!/^[a-z0-9+#_.-]+$/.test(name)) return null;
  if (["text", "plain", "plaintext", "txt", "none"].includes(name)) return "plain";
  const lib = load();
  return lib && lib.getLanguage(name) ? name : null;
}

// highlight.js HTML -> one string per source line, tokens re-opened after each line break.
function split(html) {
  const lines = [""];
  const open = []; // the spans currently open, as their class names
  const reopen = () => open.map((c) => (c ? `<span class="pane-t-${c}">` : "<span>")).join("");
  const closing = () => "</span>".repeat(open.length);
  for (const part of html.split(/(<[^>]*>|\n)/)) {
    if (part === "") continue;
    if (part === "\n") {
      lines[lines.length - 1] += closing();
      lines.push(reopen());
    } else if (part.startsWith("</")) {
      open.pop();
      lines[lines.length - 1] += "</span>";
    } else if (part.startsWith("<")) {
      const scope = (/class="([^"]*)"/.exec(part) || [])[1] || "";
      const name = scope.split(/\s+/).map((c) => c.replace(/^hljs-/, "")).find((c) => TOKENS[c]);
      // keep the stack aligned with hljs's own spans: an unmapped one still gets a slot
      open.push(name ? TOKENS[name] : "");
      lines[lines.length - 1] += name ? `<span class="pane-t-${TOKENS[name]}">` : "<span>";
    } else lines[lines.length - 1] += part;
  }
  lines[lines.length - 1] += closing();
  return lines;
}

// lines(code, language) -> { lines: [html], language: "html" | null }
// `language` is null when the text is shown plain (unknown language, no highlight.js, a failure).
function highlight(code, language) {
  const source = String(code).replace(/\r\n?/g, "\n");
  const name = resolve(language);
  if (name && name !== "plain") {
    try {
      return { lines: split(run(load(), name, source)), language: name };
    } catch (e) {
      console.warn(`pane: highlighting failed for "${name}" (${e.message}); showing plain text`);
    }
  } else if (name === null) console.warn(`pane: unknown code language "${String(language).slice(0, 40)}"; showing plain text`);
  return { lines: source.split("\n").map(escape), language: null };
}

module.exports = { highlight, resolve, TOKENS, TOKEN_CLASSES };
