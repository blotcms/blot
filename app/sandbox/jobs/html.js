// The fixed operations on HTML that came from a remote, untrusted source, for
// the jobs that run them in the jail: fetch.js (kind "html", which fetches a
// page and extracts from it) and parse-html.js (a post's HTML the importer
// already holds). Node never parses that markup itself.
//
// Every operation is named here. A caller picks one by name and never supplies
// a selector, a function or an option for the parser. What comes out is plain
// data: strings that are trimmed and length-capped, URLs that parse as http or
// https, lists that are capped. Markup that would cost too much to parse (too
// large, too many tags, too deeply nested) is a MarkupError, which the jobs
// answer as `meta.error`: a bad page is an answer, not a failure of the job.

const { extname } = require("path");

const MiB = 1024 * 1024;

// The most markup parsed at once, and the most tags in it (every "<", so
// closing tags count). Measured in a real jail, the worst patterns of 2 MiB of
// text, comment, script or one attribute (an inline base64 image) peak at
// about 220 MiB for the whole jail (Node, the parser and the Markdown
// converter loaded, the input and the output), and 30,000 tags (a few KB each
// between the parser and the Markdown converter) at about the same. A post over
// 2 MiB is almost always inline images, which the importers don't read from the
// HTML.
const MAX_HTML_BYTES = 2 * MiB;
const MAX_TAGS = 30 * 1000;
const MAX_ATTRIBUTES = 256;

// What a scan or a rewrite carries: URLs in a post, and the names they become
const MAX_URLS = 1000;
const MAX_URL_LENGTH = 2048;
const MAX_NAME_LENGTH = 512;

class MarkupError extends Error {}

// A page's own declared size for an embedded video, in pixels
const MAX_DIMENSION = 10 * 1000;

const SPACE = /[\t\n\f\r ]/;

// Why the markup can't be parsed within the jail's memory and time, if it
// can't: it is too big, has too many tags or a tag with too many attributes
// (parse5 takes 16s over 100,000 of them). One pass that reads each tag as the
// parser's tokenizer does, so a "<" or a ">" in a quoted value is not a tag.
function tooLarge(html) {
  if (Buffer.byteLength(html) > MAX_HTML_BYTES) return "markup is too large";

  const end = html.length;
  let tags = 0;
  for (let at = html.indexOf("<"); at !== -1; at = html.indexOf("<", at)) {
    if (++tags > MAX_TAGS) return "markup has too many tags";

    // Only a letter after "<" or "</" starts a tag; `<` + anything else is text
    let i = at + 1;
    if (html[i] === "/") i++;
    if (!/[A-Za-z]/.test(html[i] || "")) {
      at = at + 1;
      continue;
    }

    // The tag's name, then its attributes up to the ">"
    while (i < end && !SPACE.test(html[i]) && html[i] !== "/" && html[i] !== ">") i++;
    let attributes = 0;
    while (i < end) {
      while (i < end && (SPACE.test(html[i]) || html[i] === "/")) i++;
      if (i >= end) break;
      if (html[i] === ">") {
        i++;
        break;
      }
      if (++attributes > MAX_ATTRIBUTES) return "markup has a tag with too many attributes";

      // A name, which may start with "="
      i++;
      while (i < end && !SPACE.test(html[i]) && html[i] !== "/" && html[i] !== ">" && html[i] !== "=") i++;
      while (i < end && SPACE.test(html[i])) i++;
      if (html[i] !== "=") continue;

      // Its value: quoted, or up to a space or ">"
      i++;
      while (i < end && SPACE.test(html[i])) i++;
      if (html[i] === '"' || html[i] === "'") {
        const close = html.indexOf(html[i], i + 1);
        i = close === -1 ? end : close + 1;
      } else {
        while (i < end && !SPACE.test(html[i]) && html[i] !== ">") i++;
      }
    }
    at = i;
  }
}

// The deepest the parser may nest elements. Real pages are a few dozen deep.
// The parser and the serialiser recurse, so a document nested thousands deep
// overflows the stack, and parse5 slows down with the depth (100,000 levels
// took 40s), so the tree is cut off while it is built, not measured after.
const MAX_DEPTH = 500;

// The parser's tree adapter, with a limit on how deep a node can be put
let limited;

function treeAdapter() {
  if (limited) return limited;

  const { adapter } = require("parse5-htmlparser2-tree-adapter");
  const check = (parent) => {
    let node = parent;
    for (let depth = 0; node; depth++) {
      if (depth > MAX_DEPTH) throw new MarkupError("markup is nested too deeply");
      node = node.parent;
    }
  };

  limited = Object.assign({}, adapter, {
    appendChild(parent, child) {
      check(parent);
      adapter.appendChild(parent, child);
    },
    insertBefore(parent, child, reference) {
      check(parent);
      adapter.insertBefore(parent, child, reference);
    },
  });
  return limited;
}

// The document parse5 builds from the HTML, exactly as cheerio.load(html)
// would build it (same parser, same adapter, same options) but refused when it
// is too large, has too many tags or is nested too deeply
function parseDocument(html) {
  if (typeof html !== "string") throw new MarkupError("markup is not text");
  const reason = tooLarge(html);
  if (reason) throw new MarkupError(reason);
  return require("parse5").parse(html, { scriptingEnabled: true, treeAdapter: treeAdapter() });
}

// cheerio, which is only loaded when something is parsed
function load(html) {
  return require("cheerio").load(parseDocument(html), { decodeEntities: false });
}

// Runs an operation, turning what hostile markup does to the parser and the
// serialiser (a stack overflow in a document the depth limit missed) into a
// MarkupError
function guard(operation) {
  try {
    return operation();
  } catch (err) {
    if (err instanceof MarkupError) throw err;
    if (err instanceof RangeError) throw new MarkupError("markup is nested too deeply");
    throw err;
  }
}

function isHTTP(value) {
  if (typeof value !== "string" || !value || value.length > MAX_URL_LENGTH) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch (e) {
    return false;
  }
}

// ---- Named extractions (for the fetch job's kind "html") ----

// A video the page names in its Open Graph tags (bandcamp's player): its URL
// and size, each only if it is there. A value that is not an http(s) URL without quotes, spaces or angle
// brackets (which the caller puts in an attribute), or not a whole number of
// pixels, is left out.
function ogVideo($) {
  const content = (property) => {
    const value = $(`meta[property="${property}"]`).first().attr("content");
    return typeof value === "string" ? value.trim() : "";
  };
  const size = (property) => {
    const value = content(property);
    if (!/^\d{1,5}$/.test(value)) return undefined;
    const n = Number(value);
    return n > 0 && n <= MAX_DIMENSION ? n : undefined;
  };
  const src = content("og:video");
  const found = {};
  if (isHTTP(src) && !/["'<>\s]/.test(src)) found.src = src;
  if (size("og:video:width")) found.width = size("og:video:width");
  if (size("og:video:height")) found.height = size("og:video:height");
  return found;
}

const EXTRACTIONS = {
  "og-video": ogVideo,
};

// The data a named extraction finds in a page; throws a MarkupError
function extract(name, html) {
  if (!Object.prototype.hasOwnProperty.call(EXTRACTIONS, name)) {
    throw new MarkupError("unknown extraction");
  }
  return guard(() => EXTRACTIONS[name](load(html)));
}

// ---- Named scans and rewrites (for the parse-html job) ----

// Which elements a post's assets are in, and which of their URLs the importer
// downloads. These are the importer's own rules: the same as when the
// importer parsed the post itself.
//
// An image is any <img src>; a PDF is an <a href> whose path ends in .pdf (the
// whole link, so ".pdf?x=1" is not one); audio is any <audio src>.
function pdfLink(href) {
  return extname(href) === ".pdf";
}

const KINDS = {
  images: { tag: "img", attribute: "src", wanted: isHTTP },
  pdfs: { tag: "a", attribute: "href", wanted: (href) => isHTTP(href) && pdfLink(href) },
  audio: { tag: "audio", attribute: "src", wanted: isHTTP },
};

function kindOf(kind) {
  if (!Object.prototype.hasOwnProperty.call(KINDS, kind)) throw new MarkupError("unknown kind");
  return KINDS[kind];
}

// The URLs of one kind of asset, each once, in the order the post has them (at
// most MAX_URLS), and the post's HTML as the parser writes it back: with
// nothing to change, that is what the importer keeps.
function scan(kind, html) {
  const { tag, attribute, wanted } = kindOf(kind);
  return guard(() => {
    const $ = load(html);
    const urls = new Set();
    $(tag).each((i, el) => {
      const value = $(el).attr(attribute);
      if (urls.size < MAX_URLS && wanted(value)) urls.add(value);
    });
    return { urls: [...urls], html: $.html() };
  });
}

function checkReplacements(replacements) {
  if (!Array.isArray(replacements) || replacements.length > MAX_URLS) {
    throw new MarkupError("invalid replacements");
  }
  const map = new Map();
  for (const entry of replacements) {
    const valid =
      Array.isArray(entry) &&
      entry.length === 2 &&
      isHTTP(entry[0]) &&
      typeof entry[1] === "string" &&
      entry[1] &&
      entry[1].length <= MAX_NAME_LENGTH;
    if (!valid) throw new MarkupError("invalid replacements");
    map.set(entry[0], entry[1]);
  }
  return map;
}

// The post's HTML with each URL that has a replacement changed to it:
//   images: the <img>'s src, and the link around it if that went to the same URL
//   pdfs:   the <a>'s href, and its text if that was the URL
//   audio:  the <audio>'s src
function rewrite(kind, html, replacements) {
  const { tag, attribute } = kindOf(kind);
  const map = checkReplacements(replacements);
  return guard(() => {
    const $ = load(html);
    $(tag).each((i, el) => {
      const value = $(el).attr(attribute);
      if (typeof value !== "string" || !map.has(value)) return;
      const name = map.get(value);

      if (kind === "pdfs" && $(el).text() === value) $(el).text(name);
      $(el).attr(attribute, name);

      if (kind === "images") {
        const parent = $(el).parent();
        if (parent.attr("href") === value) parent.attr("href", name);
      }
    });
    return $.html();
  });
}

// ---- Markdown (for the parse-html job) ----

let turndown;

// Imported posts are Markdown that WordPress and others put in HTML, and
// HTML. Turndown parses the HTML.
function markdownService() {
  if (turndown) return turndown;

  const Turndown = require("turndown");
  const { gfm } = require("turndown-plugin-gfm");

  turndown = new Turndown({
    bulletListMarker: "-", // defaults to *
    codeBlockStyle: "fenced", // defaults to indented
    emDelimiter: "*", // defaults to _
  });
  turndown.use(gfm);

  // WordPress sometimes includes Markdown inside the HTML content of an item.
  // By default Turndown escapes it (_Hey_ becomes \_Hey\_) since it assumes the
  // input is pure HTML; the importer wants the Markdown, so nothing is escaped.
  turndown.escape = (text) => text;
  turndown.keep(["audio", "video", "iframe"]);
  return turndown;
}

function markdown(html) {
  // Turndown has a parser of its own; parsing the HTML here first, with the
  // limits, refuses what it would be slow or overflow on
  return guard(() => {
    parseDocument(html);
    return markdownService().turndown(html).trim();
  });
}

module.exports = {
  MarkupError,
  extract,
  scan,
  rewrite,
  markdown,
  EXTRACTIONS: Object.keys(EXTRACTIONS),
  KINDS: Object.keys(KINDS),
  MAX_HTML_BYTES,
  MAX_TAGS,
  MAX_URLS,
  MAX_URL_LENGTH,
};
