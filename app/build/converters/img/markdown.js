// A photo's EXIF ImageDescription, rendered as inline Markdown for
// entry.exif.ImageDescription

const { Marked } = require("marked");
const he = require("he");

// Written into EXIF ImageDescription by cameras, phones and apps, not by a
// person. entry.exif.ImageDescription keeps them, but they are not used as a
// caption. Compared ignoring case, with runs of whitespace collapsed.
// Sources: PhotoPrism's UnwantedStrings (internal/meta/sanitize.go),
// LibrePhotos, gThumb and KPhotoAlbum, and raw.pixls.us samples read with
// exiftool. Blank padding (Sony since 2012, Nikon, Ricoh, OM System) is
// already dropped by clean().
const CAMERA_DEFAULTS = new Set([
  "sony dsc", // Sony, about 2006 to 2011
  "default", // recent DJI cameras
  "exif_jpeg_picture",
  "samsung",
  "samsung camera pictures",
  "<digimax i5, samsung #1>",
  "hellomoto", // Motorola
  "dcf 1.0", // Minolta DiMAGE 7i
  "pentax image",
  "dvc 10.1 hdmi",
  "binary comment",
  "charset=ascii",
  "created by imlib",
  // Huawei and Honor camera modes, from PhotoPrism
  "rhdr",
  "hdrpl",
  "oznorwo",
  "frontbhdp",
  "fbt",
  "rbt",
  "ptr",
  "fbthdr",
  "btr",
  "mon",
  "nor",
  "dav",
  "mde",
  "mde_soft",
  "edf",
  "btfmdn",
  "btf",
  "btfhdr",
  "frem",
  "oznor",
  "rpt",
  "burst",
  "sdr_hdrb",
  "cof",
  "qrf",
  "fshbty",
  "_cuva",
  "smart",
  "hdr",
  "bsh",
]);

// "OLYMPUS DIGITAL CAMERA", "KONICA MINOLTA DIGITAL CAMERA", "GE DIGITAL
// CAMERA", "SANYO DIGITAL CAMERA", "Digital Camera" and the rest of the family
const DIGITAL_CAMERA = /^(?:\S+ ){0,2}digital (?:still )?camera$/;

// GoPro HERO5 to HERO11 write the file's path on the camera's card, such as
// C:\DCIM\100GOPRO\GOPR0020.GPR
const CARD_PATH = /^[a-z]:\\dcim\\\S*$/;

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

// Entities decoded, since the description may already be rendered
function fold(text) {
  return he.decode(String(text)).split(/\s+/).join(" ").trim().toLowerCase();
}

// Whether a description is one a camera wrote by default, or just names the
// camera. exif holds the photo's Make and Model, when known.
function isCameraDefault(description, exif = {}) {
  const text = clean(description);
  if (!text) return false;

  const folded = fold(text);

  if (CAMERA_DEFAULTS.has(folded)) return true;
  if (DIGITAL_CAMERA.test(folded) || CARD_PATH.test(folded)) return true;

  const make = typeof exif.Make === "string" ? fold(exif.Make) : "";
  const model = typeof exif.Model === "string" ? fold(exif.Model) : "";
  const names = [make, model, fold(make + " " + model)].filter(Boolean);

  return names.includes(folded);
}

module.exports = { clean, render, isCameraDefault };
