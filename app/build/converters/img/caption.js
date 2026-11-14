// A photo's caption, from exiftool's MWG:Description, turned into the inline
// HTML shown under an image post. build/prepare makes its summary from it.

const { Marked } = require("marked");
const cheerio = require("cheerio");

// Written by cameras into EXIF ImageDescription, not by a person
const CAMERA_DEFAULTS = [
  "OLYMPUS DIGITAL CAMERA",
  "SONY DSC",
  "EXIF_JPEG_PICTURE",
  "JENOPTIK DIGITAL CAMERA",
];

// Longer than any caption a person writes, short enough to stay cheap
const MAX_LENGTH = 4096;

// The tags Markdown's inline syntax produces. Raw HTML and images in a
// caption are shown as text, so nothing else should appear, but the
// rendered HTML is checked against this list anyway.
const ALLOWED_TAGS = ["a", "br", "code", "em", "strong"];
const SAFE_HREF = /^(https?:|mailto:|[^:]*$)/i;

function escape(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// CommonMark, without GitHub's extensions (bare URLs, strikethrough)
const markdown = new Marked({ gfm: false, breaks: false, async: false });

markdown.use({
  renderer: {
    html(html) {
      return escape(html);
    },
    // text is the alt text, already escaped
    image(href, title, text) {
      return text;
    },
    link(href, title, text) {
      if (!SAFE_HREF.test(href || "")) return text;
      return false;
    },
  },
});

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

// Keeps only ALLOWED_TAGS (and an a's href and title); any other element
// becomes its text
function sanitize(html) {
  const $ = cheerio.load(html, null, false);

  $("*").each(function () {
    const el = $(this);
    const name = this.tagName.toLowerCase();

    if (!ALLOWED_TAGS.includes(name)) {
      el.replaceWith(escape(el.text()));
      return;
    }

    for (const attr of Object.keys(this.attribs || {})) {
      const keep =
        name === "a" &&
        (attr === "title" ||
          (attr === "href" && SAFE_HREF.test(el.attr(attr))));
      if (!keep) el.removeAttr(attr);
    }
  });

  return $.html();
}

// Inline Markdown to HTML: bold, italic, links and code. Block syntax
// (headings, lists, quotes) stays as written, and a line break becomes <br>.
function render(caption) {
  const text = clean(caption);
  if (!text) return null;

  const html = markdown
    .parseInline(text)
    .replace(/<br>\n/g, "<br>")
    .replace(/\n/g, "<br>");

  return sanitize(html);
}

module.exports = { clean, render };
