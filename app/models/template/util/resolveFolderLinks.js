const { posix } = require("path");
const mime = require("mime-types");
const BLOT_CDN_TOKEN = require("blog/render/replaceFolderLinks/cdnToken");
const {
  htmlExtRegex,
  fileExtRegex,
  hostPatterns,
  stripOwnHost,
  pathPartOf,
  isSafeCdnTarget,
} = require("blog/render/replaceFolderLinks/shared");

// Template views can't be baked per blog at render time the way entries are
// (app/build/plugins/folderAssets), and rewriting the whole rendered page on
// every request (app/blog/render/replaceFolderLinks) is the cost this module
// exists to remove. Instead, when a view is saved (setView), literal links to
// files in the blog's folder are wrapped in the existing {{#cdn}} helper:
//
//   <img src="/a.png">  ->  <img src="{{#cdn}}/a.png{{/cdn}}">
//
// The template's CDN manifest (util/updateCdnManifest) then resolves each
// wrapped target to a versioned CDN URL, and a dependency index regenerates
// the manifest when the file changes. The result is stored on the view as
// `resolvedContent` and is only ever used as the render source; the author's
// `content` is untouched.
//
// This works on the raw template text, not a parsed DOM: parse5/cheerio
// would mangle {{...}}, and only the bytes of the links themselves may
// change. Everything outside an edited span is copied through byte for byte.
// Mustache tags are opaque: nothing inside one is ever read as HTML or CSS,
// and a value containing a tag is left alone (the one exception is a value
// that starts with {{blog.url}}, followed by a literal path).
//
// The eligibility rules deliberately mirror the request-time pass
// (replaceFolderLinks/html.js and css.js) so the two agree about which links
// are folder files:
//   - href, src, poster and each srcset candidate; CSS url(...) in CSS views,
//     <style> blocks and style="" attributes
//   - own-host absolute URLs are treated as paths; other hosts, data:, mailto:
//     and other schemes, #fragments, paths ending in .html and paths whose
//     last segment has no extension are skipped
//   - one addition: literal <meta content="/path/to/file.ext"> (og:image and
//     friends), which the request-time pass never touched
//
// Relative links. HTML views have no single URL (they can be served at many
// URL patterns), so a relative link keeps the request-time pass's semantics:
// it is resolved against "/". A CSS view is served at one URL, so a relative
// url() in it is resolved the way the browser does: against the directory of
// the view's url. Sites that worked only because of the old root-relative
// behaviour must keep working, so when the browser-correct path differs from
// the root-relative one, the wrapper records the root-relative path in a
// Mustache comment right after the section:
//
//   url({{#cdn}}/css/img/a.png{{/cdn}}{{!root-fallback:/img/a.png}})
//
// The comment renders as nothing. The manifest builder reads it back with
// rootFallbacks() and uses the fallback path if the browser-correct file
// doesn't exist.
//
// Returns the original string (the same value) when nothing qualifies.

// Cheap pre-check: whether the text could contain a link to rewrite at all.
const CANDIDATE = /(?:\b(?:href|src|poster|srcset|content|style)\s*=|url\s*\()/i;

// {{=<% %>=}} changes what a tag looks like for the rest of the template, so
// the {{#cdn}} we'd insert would render as literal text. Leave such views to
// the request-time pass.
const DELIMITER_CHANGE = /\{\{=/;

const BLOG_URL_PREFIX =
  /^(?:\{\{\{\s*blog\.url\s*\}\}\}|\{\{&?\s*blog\.url\s*\}\})/;

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

const RAW_TEXT_ELEMENTS = { script: 1, textarea: 1, title: 1 };

const FALLBACK_REGEX =
  /\{\{#cdn\}\}([^{}]*)\{\{\/cdn\}\}\{\{!root-fallback:([^{}]*)\}\}/g;

function isSpace(ch) {
  return ch === " " || ch === "\n" || ch === "\t" || ch === "\r" || ch === "\f";
}

function hasMustache(value) {
  return value.indexOf("{{") > -1 || value.indexOf("}}") > -1;
}

function viewKind(options) {
  const type = options.viewType || mime.lookup(options.viewName || "") || "text/html";

  if (type === "text/html") return "html";
  if (type === "text/css") return "css";

  return null;
}

// A CSS view's relative url() values resolve against the directory it is
// served from. A url with route parameters has no single directory.
function cssDirectory(options) {
  let url = pathPartOf(options.viewUrl || "/" + (options.viewName || ""));

  if (/[:*(){}?+[\]|]/.test(url)) return "/";
  if (url.charAt(0) !== "/") url = "/" + url;

  return posix.dirname(url);
}

// A target ends up as the text of a {{#cdn}} section, which the template
// parser only accepts as a manifest target if it passes these checks
// (parseTemplate collectCdnTargets); anything else would be dead weight.
const isSafeTarget = isSafeCdnTarget;

function normalizeAbsolute(path) {
  if (/(?:^|\/)\.{1,2}(?:\/|$)|\/\//.test(path)) return posix.resolve("/", path);

  return path;
}

// ---------------------------------------------------------------------------
// Mustache tags
// ---------------------------------------------------------------------------

// Reads the tag starting at src[i] === "{". Returns null if it never closes.
function readTag(src, i) {
  const triple = src.charAt(i + 2) === "{";
  const close = src.indexOf(triple ? "}}}" : "}}", i + (triple ? 3 : 2));

  if (close === -1) return null;

  const inner = src.slice(i + (triple ? 3 : 2), close).trim();
  const sigil = inner.charAt(0);
  const hasSigil = "#^/>&!<".indexOf(sigil) > -1 && sigil !== "";

  return {
    end: close + (triple ? 3 : 2),
    sigil: hasSigil ? sigil : "",
    name: hasSigil ? inner.slice(1).trim() : inner,
  };
}

// Steps over a tag, returning the index after it. Tracks whether we're inside
// someone's own {{#cdn}} section (track = false when re-scanning text that was
// already walked, so each tag is only counted once).
function consumeTag(ctx, i, track) {
  const tag = readTag(ctx.src, i);

  if (!tag) return i + 2;

  if (track !== false && tag.name === "cdn") {
    if (tag.sigil === "#" || tag.sigil === "^") ctx.depth++;
    else if (tag.sigil === "/") ctx.depth = Math.max(0, ctx.depth - 1);
  }

  return tag.end;
}

// ---------------------------------------------------------------------------
// A single link value
// ---------------------------------------------------------------------------

// Returns the text to replace the value with, or null to leave it alone.
// opts.dir is the directory relative links resolve against (CSS views only);
// opts.strictRoot only accepts links that are already rooted (<meta content>).
function linkReplacement(ctx, value, opts) {
  if (ctx.depth > 0) return null;
  if (!value || value !== value.trim()) return null;
  if (value.indexOf(BLOT_CDN_TOKEN) > -1) return null;

  let raw;
  const blogUrl = BLOG_URL_PREFIX.exec(value);

  if (blogUrl) {
    // {{blog.url}}/path/to/file.ext - the path after the tag is a literal
    raw = value.slice(blogUrl[0].length);

    if (raw.charAt(0) !== "/" || raw.charAt(1) === "/") return null;
    if (hasMustache(raw)) return null;
  } else {
    if (hasMustache(value)) return null;

    raw = stripOwnHost(ctx.patterns, value);

    // another host, e.g. //cdn.example.com/a.png
    if (raw.charAt(0) === "/" && raw.charAt(1) === "/") return null;
  }

  if (!raw || raw.charAt(0) === "#" || raw.charAt(0) === "?") return null;
  if (SCHEME.test(raw)) return null;
  if (opts.strictRoot && raw.charAt(0) !== "/") return null;

  const pathPart = pathPartOf(raw);
  const suffix = raw.slice(pathPart.length);

  let path;
  let rootPath = null;

  if (pathPart.charAt(0) === "/") {
    path = normalizeAbsolute(pathPart);
  } else {
    path = posix.resolve(opts.dir || "/", pathPart);

    if (opts.dir && opts.dir !== "/") {
      const fromRoot = posix.resolve("/", pathPart);
      if (fromRoot !== path) rootPath = fromRoot;
    }
  }

  if (htmlExtRegex.test(path) || !fileExtRegex.test(path)) return null;

  const target = path + suffix;

  if (!isSafeTarget(target)) return null;

  let replacement = "{{#cdn}}" + target + "{{/cdn}}";

  if (rootPath && isSafeTarget(rootPath + suffix)) {
    replacement += "{{!root-fallback:" + rootPath + suffix + "}}";
  }

  return replacement;
}

function rewrite(ctx, start, end, opts) {
  if (end <= start) return;

  const replacement = linkReplacement(ctx, ctx.src.slice(start, end), opts);

  if (replacement !== null) ctx.edits.push({ start, end, text: replacement });
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

function scanCss(ctx, from, to, dir) {
  const src = ctx.src;
  let i = from;

  while (i < to) {
    const ch = src.charAt(i);

    if (ch === "{" && src.charAt(i + 1) === "{") {
      i = consumeTag(ctx, i);
    } else if (ch === "/" && src.charAt(i + 1) === "*") {
      const close = src.indexOf("*/", i + 2);
      i = close === -1 || close + 2 > to ? to : close + 2;
    } else if (ch === '"' || ch === "'") {
      i = skipCssString(ctx, i, to);
    } else if (
      (ch === "u" || ch === "U") &&
      /^url\(/i.test(src.substr(i, 4)) &&
      !/[\w-]/.test(i > from ? src.charAt(i - 1) : "")
    ) {
      i = scanCssUrl(ctx, i, to, dir);
    } else {
      i++;
    }
  }
}

function skipCssString(ctx, i, to) {
  const src = ctx.src;
  const quote = src.charAt(i);
  let k = i + 1;

  while (k < to) {
    const ch = src.charAt(k);

    if (ch === "\\") k += 2;
    else if (ch === "{" && src.charAt(k + 1) === "{") k = consumeTag(ctx, k);
    else if (ch === quote) return k + 1;
    else if (ch === "\n") return k;
    else k++;
  }

  return to;
}

// src[i..i+4] is "url(". Returns the index to carry on scanning from.
function scanCssUrl(ctx, i, to, dir) {
  const src = ctx.src;
  let p = i + 4;

  while (p < to && isSpace(src.charAt(p))) p++;

  if (p >= to) return to;

  const quote = src.charAt(p);

  if (quote === '"' || quote === "'") {
    const valueStart = p + 1;
    let k = valueStart;

    while (k < to && src.charAt(k) !== quote) {
      const ch = src.charAt(k);

      if (ch === "\\") k += 2;
      else if (ch === "{" && src.charAt(k + 1) === "{") k = consumeTag(ctx, k);
      else if (ch === "\n") return k;
      else k++;
    }

    if (k >= to) return to;

    let after = k + 1;
    while (after < to && isSpace(src.charAt(after))) after++;

    // not a well-formed url("...") - leave it alone, as the request-time
    // pass's strict regex does
    if (src.charAt(after) !== ")") return k + 1;

    rewrite(ctx, valueStart, k, { dir });

    return after + 1;
  }

  const valueStart = p;
  let k = p;

  while (k < to && src.charAt(k) !== ")") {
    const ch = src.charAt(k);

    if (ch === "{" && src.charAt(k + 1) === "{") k = consumeTag(ctx, k);
    else if (ch === '"' || ch === "'" || ch === "(") return k + 1;
    else k++;
  }

  if (k >= to) return to;

  let valueEnd = k;
  while (valueEnd > valueStart && isSpace(src.charAt(valueEnd - 1))) valueEnd--;

  rewrite(ctx, valueStart, valueEnd, { dir });

  return k + 1;
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function scanHtml(ctx, from, to) {
  const src = ctx.src;
  let i = from;

  while (i < to) {
    const lt = src.indexOf("<", i);
    const tag = src.indexOf("{{", i);

    if (tag !== -1 && tag < to && (lt === -1 || tag < lt)) {
      i = consumeTag(ctx, tag);
      continue;
    }

    if (lt === -1 || lt >= to) return;

    i = lt;

    if (src.startsWith("<!--", i)) {
      const close = src.indexOf("-->", i + 4);
      i = close === -1 ? to : close + 3;
    } else if (src.startsWith("<!", i) || src.startsWith("<?", i)) {
      const close = src.indexOf(">", i);
      i = close === -1 ? to : close + 1;
    } else if (src.startsWith("</", i)) {
      const close = src.indexOf(">", i);
      i = close === -1 ? to : close + 1;
    } else if (/[a-zA-Z]/.test(src.charAt(i + 1))) {
      i = scanOpenTag(ctx, i, to);
    } else {
      i++;
    }
  }
}

// src[i] is the "<" of an opening tag. Rewrites the links in its attributes
// and returns the index to carry on from (past the tag, and past the body of
// a raw-text element such as <script>).
function scanOpenTag(ctx, i, to) {
  const src = ctx.src;
  let p = i + 1;

  while (p < to && /[^\s/>{]/.test(src.charAt(p))) p++;

  const name = src.slice(i + 1, p).toLowerCase();
  const attributes = [];

  while (p < to) {
    while (p < to && (isSpace(src.charAt(p)) || src.charAt(p) === "/")) p++;

    if (p >= to) break;

    if (src.charAt(p) === ">") {
      p++;
      break;
    }

    if (src.charAt(p) === "{" && src.charAt(p + 1) === "{") {
      p = consumeTag(ctx, p);
      continue;
    }

    const nameStart = p;

    while (
      p < to &&
      !/[\s=>/]/.test(src.charAt(p)) &&
      !(src.charAt(p) === "{" && src.charAt(p + 1) === "{")
    )
      p++;

    if (p === nameStart) {
      p++;
      continue;
    }

    const attribute = src.slice(nameStart, p).toLowerCase();
    let q = p;

    while (q < to && isSpace(src.charAt(q))) q++;

    if (src.charAt(q) !== "=") continue;

    p = q + 1;

    while (p < to && isSpace(src.charAt(p))) p++;

    const quote = src.charAt(p);
    let start, end;

    if (quote === '"' || quote === "'") {
      start = p + 1;
      end = start;

      while (end < to && src.charAt(end) !== quote) {
        if (src.charAt(end) === "{" && src.charAt(end + 1) === "{")
          end = consumeTag(ctx, end);
        else end++;
      }

      p = end < to ? end + 1 : end;
    } else {
      start = p;
      end = p;

      while (end < to && !isSpace(src.charAt(end)) && src.charAt(end) !== ">") {
        if (src.charAt(end) === "{" && src.charAt(end + 1) === "{")
          end = consumeTag(ctx, end);
        else end++;
      }

      p = end;
    }

    attributes.push({ name: attribute, start, end: Math.min(end, to) });
  }

  attributes.forEach(function (attribute) {
    if (
      attribute.name === "href" ||
      attribute.name === "src" ||
      attribute.name === "poster"
    ) {
      rewrite(ctx, attribute.start, attribute.end, {});
    } else if (attribute.name === "srcset") {
      scanSrcset(ctx, attribute.start, attribute.end);
    } else if (attribute.name === "content" && name === "meta") {
      rewrite(ctx, attribute.start, attribute.end, { strictRoot: true });
    } else if (attribute.name === "style") {
      scanCss(ctx, attribute.start, attribute.end, null);
    }
  });

  if (name === "style" || RAW_TEXT_ELEMENTS[name]) {
    const closing = new RegExp("</" + name, "gi");
    closing.lastIndex = p;
    const match = closing.exec(src);
    const end = match ? match.index : to;

    if (name === "style") scanCss(ctx, p, end, null);

    return end;
  }

  return p;
}

// Candidates are split at commas and each URL is its first whitespace
// delimited token, exactly as the request-time pass's parseSrcset does.
function scanSrcset(ctx, from, to) {
  const src = ctx.src;
  let pieceStart = from;
  let k = from;

  while (k <= to) {
    if (k === to || src.charAt(k) === ",") {
      rewriteCandidate(ctx, pieceStart, k);
      pieceStart = k + 1;
      k++;
    } else if (src.charAt(k) === "{" && src.charAt(k + 1) === "{") {
      k = consumeTag(ctx, k, false);
    } else {
      k++;
    }
  }
}

function rewriteCandidate(ctx, from, to) {
  const src = ctx.src;
  let start = from;

  while (start < to && isSpace(src.charAt(start))) start++;

  let end = start;

  while (end < to && !isSpace(src.charAt(end))) {
    if (src.charAt(end) === "{" && src.charAt(end + 1) === "{")
      end = consumeTag(ctx, end, false);
    else end++;
  }

  rewrite(ctx, start, Math.min(end, to), {});
}

// ---------------------------------------------------------------------------

// content: the view's template text
// options.viewName: the view's name, e.g. "style.css"
// options.viewUrl: the view's url, if it has one (resolves CSS relative links)
// options.viewType: legacy explicit content type of the view, if any
// options.hosts: the blog's own hostnames (blog/lib/blogHosts)
function resolveFolderLinks(content, options) {
  options = options || {};

  if (!mayContainFolderLinks(content)) return content;

  const kind = viewKind(options);

  if (!kind) return content;

  const ctx = {
    src: content,
    edits: [],
    patterns: hostPatterns(options.hosts),
    depth: 0,
  };

  try {
    if (kind === "css") {
      scanCss(ctx, 0, content.length, cssDirectory(options));
    } else {
      scanHtml(ctx, 0, content.length);
    }
  } catch (err) {
    // A bug here must never stop a template saving: the request-time pass
    // still covers the view.
    console.error("resolveFolderLinks failed for", options.viewName, err);
    return content;
  }

  if (!ctx.edits.length) return content;

  ctx.edits.sort((a, b) => a.start - b.start);

  let output = "";
  let cursor = 0;

  for (const edit of ctx.edits) {
    if (edit.start < cursor) continue;

    output += content.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }

  return output + content.slice(cursor);
}

function mayContainFolderLinks(content) {
  return (
    typeof content === "string" &&
    content.length > 0 &&
    CANDIDATE.test(content) &&
    !DELIMITER_CHANGE.test(content)
  );
}

// The root-relative fallbacks recorded next to browser-correct CSS targets,
// as { target: fallbackTarget }, both without a leading slash (the form
// parseTemplate puts in retrieve.cdn).
function rootFallbacks(resolvedContent) {
  const fallbacks = {};

  if (typeof resolvedContent !== "string" || resolvedContent.indexOf("root-fallback") === -1)
    return fallbacks;

  const regex = new RegExp(FALLBACK_REGEX.source, "g");
  let match;

  while ((match = regex.exec(resolvedContent))) {
    fallbacks[match[1].trim().replace(/^\//, "")] = match[2]
      .trim()
      .replace(/^\//, "");
  }

  return fallbacks;
}

module.exports = resolveFolderLinks;
module.exports.mayContainFolderLinks = mayContainFolderLinks;
module.exports.rootFallbacks = rootFallbacks;
