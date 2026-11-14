// A photo's EXIF ImageDescription, rendered as inline Markdown for
// entry.exif.ImageDescription

const { Marked } = require("marked");

// Longer than any description a person writes, short enough to stay cheap
const MAX_LENGTH = 4096;

// CommonMark, without GitHub's extensions (bare URLs, strikethrough). Like
// the rest of a post, raw HTML in a description is passed through as written.
const markdown = new Marked({ gfm: false, breaks: false, async: false });

function escape(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// [[target]], [[target|text]] and ![[target|alt]] become the markup pandoc
// gives wikilinks in a post (title="wikilink"), which the wikilinks plugin
// resolves (build/single.js runs it on the description)
const wikilink = {
  name: "wikilink",
  level: "inline",
  start(src) {
    const index = src.search(/!?\[\[/);
    return index < 0 ? undefined : index;
  },
  tokenizer(src) {
    const match = /^(!?)\[\[([^[\]\n|]+?)(?:\|([^[\]\n]+?))?\]\]/.exec(src);
    if (!match) return;
    const target = match[2].trim();
    if (!target) return;
    return {
      type: "wikilink",
      raw: match[0],
      embed: match[1] === "!",
      target,
      text: (match[3] || "").trim() || target,
    };
  },
  renderer({ embed, target, text }) {
    if (embed)
      return `<img src="${escape(target)}" title="wikilink" alt="${escape(text)}">`;
    return `<a href="${escape(target)}" title="wikilink">${escape(text)}</a>`;
  },
};

// A line break in the text becomes <br>. Raw HTML, which can span lines,
// is left as written.
markdown.use({
  extensions: [wikilink],
  renderer: {
    text(text) {
      return text.replace(/\n/g, "<br>");
    },
  },
});

// Returns the description as written, trimmed, or null when it is missing
// or blank.
function clean(description) {
  if (typeof description !== "string") return null;

  const text = description
    .split("\u0000")
    .join("")
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, MAX_LENGTH)
    .trim();

  if (!text) return null;

  return text;
}

// Inline Markdown to HTML: bold, italic, links, code and wikilinks. Block syntax
// (headings, lists, quotes) stays as written, and a line break becomes <br>.
function render(description) {
  const text = clean(description);
  if (!text) return null;

  return markdown.parseInline(text);
}

module.exports = { clean, render };
