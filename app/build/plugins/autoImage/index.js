const { URL } = require("url");
const { posix } = require("path");

// Define a list of common image extensions
const imageExtensions = [
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".bmp",
  ".webp",
  ".svg",
];

function render($, callback) {
  $("a").each(function () {
    try {
      const href = $(this).attr("href");
      const text = $(this).text();
      const isImage = IsImage(href);

      if (href && isImage && isBareLabel(href, text)) {
        $(this).replaceWith(template(href));
      }
    } catch (e) {}
  });

  callback();
}

function template(url) {
  return '<img src="' + url + '" />';
}

// A "bare" link is one whose label is just its own destination,
// e.g. <a href="photo.jpg">photo.jpg</a>, rather than a custom
// label like <a href="photo.jpg">My photo</a>. This used to be a
// simple equality check, but a relative local href is now resolved
// to an absolute path (e.g. /posts/photo.jpg) before this plugin
// runs, while the link's text still holds the original, unresolved
// reference the author typed - so we also accept href ending in
// "/" + text, after collapsing any "./", "../" or internal "x/../"
// segments in text (e.g. "../photo.jpg" or "foo/../photo.jpg" both
// reduce to "photo.jpg") as still being bare.
// This is a heuristic, not a re-derivation of the original href:
// it can't distinguish "text that resolved to this href" from "text
// that merely shares a filename with an unrelated href in a
// different folder" (e.g. href="/other/photo.jpg", text="photo.jpg"
// would also match). That's an accepted, low-stakes tradeoff here -
// worst case a link renders as an image instead of a link.
function isBareLabel(href, text) {
  if (!text) return false;
  if (href === text) return true;

  // The href was already stripped of embedded tab/newline characters,
  // trimmed, and (if local) resolved before this plugin runs, but the
  // label's text is never touched - so a whitespace-mangled bare link
  // like <a href="photo.\njpg">photo.\njpg</a> needs the same
  // normalization applied to its text here to still compare equal,
  // the same way a URL parser would treat the mangled href.
  const trimmedText = text.replace(/[\t\r\n]/g, "").trim();

  if (href === trimmedText) return true;

  // dependencies/index.js normalizes backslashes to forward slashes
  // on the href side before resolving (browsers treat them the same
  // for http(s) pages) - apply the same normalization to the label
  // here, e.g. "photos\photo.jpg" should still match a resolved href
  // ending in "/photos/photo.jpg".
  const normalizedText = trimmedText.replace(/\\/g, "/");

  // path.posix.normalize collapses internal "x/../" segments, but
  // it can't collapse *leading* "../"/"./" ones (there's nothing
  // before them to cancel against) - strip those separately, since
  // they cancel out against the directory of the file resolve()
  // already applied to produce href.
  const cleanText = posix
    .normalize(normalizedText)
    .replace(/^(?:\.\.?\/)+/, "")
    .replace(/\/$/, "");

  return !!cleanText && href.slice(-(cleanText.length + 1)) === "/" + cleanText;
}

function IsImage(url) {
  if (!url) return false;

  try {
    // Parse the URL using the Node.js URL library
    const parsedURL = new URL(url, "http://example.com"); // Use a base URL for relative URLs

    // Check if the protocol is valid (http or https)
    const validProtocols = ["http:", "https:"];
    if (!validProtocols.includes(parsedURL.protocol)) {
      return false;
    }

    // Extract the file extension from the pathname
    const pathname = parsedURL.pathname.toLowerCase();
    return imageExtensions.some((ext) => pathname.endsWith(ext));
  } catch (e) {
    // If URL parsing fails, return false
    return false;
  }
}

module.exports = {
  render: render,
  category: "embeds",
  title: "Images",
  description: "Embed images from image links",
};
