// A photo's caption, from exiftool's MWG:Description, turned into the inline
// HTML shown under an image post. build/prepare makes its summary from it.

const { Marked } = require("marked");

// Written by cameras into EXIF ImageDescription, not by a person
const CAMERA_DEFAULTS = [
  "OLYMPUS DIGITAL CAMERA",
  "SONY DSC",
  "EXIF_JPEG_PICTURE",
  "JENOPTIK DIGITAL CAMERA",
];

// Longer than any caption a person writes, short enough to stay cheap
const MAX_LENGTH = 4096;

// CommonMark, without GitHub's extensions (bare URLs, strikethrough). Like
// the rest of a post, raw HTML in a caption is passed through as written.
const markdown = new Marked({ gfm: false, breaks: false, async: false });

// Returns the caption as written, or null for a missing, blank or camera
// default description.
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
  if (CAMERA_DEFAULTS.includes(text.toUpperCase())) return null;

  return text;
}

// Inline Markdown to HTML: bold, italic, links and code. Block syntax
// (headings, lists, quotes) stays as written, and a line break becomes <br>.
function render(caption) {
  const text = clean(caption);
  if (!text) return null;

  return markdown
    .parseInline(text)
    .replace(/<br>\n/g, "<br>")
    .replace(/\n/g, "<br>");
}

module.exports = { clean, render };
