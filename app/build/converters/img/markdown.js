// A photo's EXIF ImageDescription, rendered as inline Markdown for
// entry.exif.ImageDescription

const { Marked } = require("marked");

// Longer than any description a person writes, short enough to stay cheap
const MAX_LENGTH = 4096;

// CommonMark, without GitHub's extensions (bare URLs, strikethrough). Like
// the rest of a post, raw HTML in a description is passed through as written.
const markdown = new Marked({ gfm: false, breaks: false, async: false });

// A line break in the text becomes <br>. Raw HTML, which can span lines,
// is left as written.
markdown.use({
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

// Inline Markdown to HTML: bold, italic, links and code. Block syntax
// (headings, lists, quotes) stays as written, and a line break becomes <br>.
function render(description) {
  const text = clean(description);
  if (!text) return null;

  return markdown.parseInline(text);
}

module.exports = { clean, render };
