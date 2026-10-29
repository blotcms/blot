const { posix } = require("path");
const mime = require("mime-types");
const Mustache = require("mustache");
const BLOT_CDN_TOKEN = require("blog/render/replaceFolderLinks/cdnToken");
const {
  htmlExtRegex,
  fileExtRegex,
  hostPatterns,
  stripOwnHost,
  pathPartOf,
  isSafeCdnTarget,
} = require("blog/render/replaceFolderLinks/shared");

// Template views can't be baked per blog at build time the way entries are
// (app/build/plugins/folderAssets). Instead, when a blog's own template view
// is assembled for rendering (getFullView, getPartials), literal links to
// files in the blog's folder are wrapped in the existing {{#cdn}} helper:
//
//   <img src="/a.png">  ->  <img src="{{#cdn}}/a.png{{/cdn}}">
//
// The template's CDN manifest (util/updateCdnManifest) resolves each wrapped
// target to a versioned CDN URL, from the same wrapping of the same views
// (wrapFolderLinks below), and a dependency index regenerates the manifest
// when the file changes. The wrapped copy is never stored: view.content stays
// the author's source, and is what is analysed, edited and exported.
//
// This works on the raw template text, not a parsed DOM: parse5/cheerio
// would mangle {{...}}, and only the bytes of the links themselves may
// change. Everything outside an edited span is copied through byte for byte.
// Mustache tags are opaque: nothing inside one is ever read as HTML or CSS,
// and a value containing a tag is left alone (the one exception is a value
// that starts with {{blog.url}}, {{blogURL}} or {{siteURL}}, followed by a
// literal path).
//
// Which links are folder files (the rules of the request-time folder-link pass
// this replaced):
//   - href, src, poster and each srcset candidate; CSS url(...) in CSS views,
//     <style> blocks and style="" attributes
//   - own-host absolute URLs are treated as paths; other hosts, data:, mailto:
//     and other schemes, #fragments, paths ending in .html and paths whose
//     last segment has no extension are skipped
//   - relative links are resolved against "/", in HTML and CSS views alike
//   - one addition: literal <meta content="/path/to/file.ext"> (og:image and
//     friends), which the old pass never covered
//
// Returns the original string (the same value) when nothing qualifies.

// Cheap pre-check: whether the text could contain a link to rewrite at all.
const CANDIDATE = /(?:\b(?:href|src|poster|srcset|content|style)\s*=|url\s*\()/i;

// {{=<% %>=}} changes what a tag looks like for the rest of the template, so
// the {{#cdn}} we'd insert would render as literal text. Such views are left
// as written.
const DELIMITER_CHANGE = /\{\{=/;

// The tags which render as the blog's own origin: blog.url is its canonical
// URL, blogURL (and its alias siteURL) the one the request came in on.
const BLOG_URL_PREFIX =
  /^(?:\{\{\{\s*(?:blog\.url|blogURL|siteURL)\s*\}\}\}|\{\{&?\s*(?:blog\.url|blogURL|siteURL)\s*\}\})/;

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

const RAW_TEXT_ELEMENTS = { script: 1, textarea: 1, title: 1 };

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

// Returns the {{#cdn}} target to wrap the value in, or null to leave it alone.
// opts.css marks a CSS url() value. opts.strictRoot only accepts links that are already rooted (<meta content>).
function linkTarget(ctx, value, opts) {
  if (ctx.depth > 0) return null;
  if (!value || value !== value.trim()) return null;
  if (value.indexOf(BLOT_CDN_TOKEN) > -1) return null;

  let raw;
  const blogUrl = BLOG_URL_PREFIX.exec(value);

  if (blogUrl) {
    // {{blog.url}}/path/to/file.ext (or {{blogURL}}) - the path after the tag is a literal
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

  let pathPart = pathPartOf(raw);
  const suffix = raw.slice(pathPart.length);

  // A relative link stays relative inside the section: the manifest is keyed
  // without a leading slash, so it resolves against "/" just as a rooted one
  // does, and a miss is left as written. A leading "./" changes nothing and
  // is dropped. ".." can't be kept as written: in HTML there is no fixed
  // base URL to climb from, so the link is left alone, but a CSS url() is
  // relative to the stylesheet, which is served from the blog root (as it is
  // from the CDN, where ".." would climb out of the template), so it resolves
  // against "/" like a rooted link, clamped at the blog root.
  if (pathPart.charAt(0) !== "/") {
    pathPart = pathPart.replace(/^(?:\.\/)+/, "");
    if (/(?:^|\/)\.{1,2}(?:\/|$)/.test(pathPart)) {
      if (!opts.css) return null;
      pathPart = posix.resolve("/", pathPart);
    }
  }

  const path =
    pathPart.charAt(0) === "/" ? normalizeAbsolute(pathPart) : pathPart;

  if (htmlExtRegex.test(path) || !fileExtRegex.test(path)) return null;

  const target = encodeTarget(path + suffix);

  return isSafeCdnTarget(target) ? target : null;
}

// A {{#cdn}} target can't contain whitespace, but file names often have
// spaces, so percent-encode them. The manifest builder decodes the path
// before looking the file up, so a literal "%" that doesn't start an escape
// ("100% luck.jpg") is encoded too, or the path wouldn't decode.
function encodeTarget(value) {
  return value
    .replace(/%(?![0-9a-fA-F]{2})/g, "%25")
    .split(" ")
    .join("%20");
}

// The {{#cdn}} target for a plain value which is, in its entirety, a link to
// a file in the blog's folder: "/a.png", "https://<own host>/a.png" or
// "{{blog.url}}/a.png". Returns it without a leading slash (the form the
// manifest is keyed by), or null. For values that never pass through the
// template text, so it only accepts rooted links: there is no page to
// resolve a relative one against.
function folderTarget(value, hosts) {
  return folderTargetFor(hostPatterns(hosts), value);
}

function folderTargetFor(patterns, value) {
  if (typeof value !== "string" || value.length > 1024) return null;

  const target = linkTarget({ depth: 0, patterns }, value, {
    strictRoot: true,
  });

  return target ? target.replace(/^\//, "") : null;
}

function rewrite(ctx, start, end, opts) {
  if (end <= start) return;

  const target = linkTarget(ctx, ctx.src.slice(start, end), opts);

  if (target !== null) ctx.edits.push({ start, end, target });
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

function scanCss(ctx, from, to) {
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
      i = scanCssUrl(ctx, i, to);
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
function scanCssUrl(ctx, i, to) {
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

    // not a well-formed url("...") - leave it alone
    if (src.charAt(after) !== ")") return k + 1;

    rewrite(ctx, valueStart, k, { css: true });

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

  rewrite(ctx, valueStart, valueEnd, { css: true });

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
      scanCss(ctx, attribute.start, attribute.end);
    }
  });

  if (name === "style" || RAW_TEXT_ELEMENTS[name]) {
    const closing = new RegExp("</" + name, "gi");
    closing.lastIndex = p;
    const match = closing.exec(src);
    const end = match ? match.index : to;

    if (name === "style") scanCss(ctx, p, end);

    return end;
  }

  return p;
}

// Candidates are split at commas and each URL is its first whitespace
// delimited token, as parseSrcset in
// replaceFolderLinks/shared does. A srcset with an empty candidate (", /a.png 1x" or a trailing comma)
// is malformed and left entirely alone.
function scanSrcset(ctx, from, to) {
  const src = ctx.src;
  const pieces = [];
  let pieceStart = from;
  let k = from;

  while (k <= to) {
    if (k === to || src.charAt(k) === ",") {
      if (!src.slice(pieceStart, k).trim()) return;

      pieces.push([pieceStart, k]);
      pieceStart = k + 1;
      k++;
    } else if (src.charAt(k) === "{" && src.charAt(k + 1) === "{") {
      k = consumeTag(ctx, k, false);
    } else {
      k++;
    }
  }

  pieces.forEach((piece) => rewriteCandidate(ctx, piece[0], piece[1]));
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
// options.viewType: legacy explicit content type of the view, if any
// options.hosts: the blog's own hostnames (blog/lib/blogHosts)
function resolveFolderLinks(content, options) {
  return wrapFolderLinks(content, options).content;
}

// Returns { content, targets }: the content with its folder links wrapped,
// and the {{#cdn}} targets the wrapping added, sorted and without their
// leading slash (the form parseTemplate puts in retrieve.cdn and the manifest
// is keyed by). getFullView and getPartials render the content and add the
// targets to the view's retrieve.cdn, so the {{#cdn}} helper is loaded;
// updateCdnManifest resolves the same targets. Both call this with the same
// view and hosts, so the two can't drift apart.
function wrapFolderLinks(content, options) {
  options = options || {};

  const unchanged = { content, targets: [] };

  if (!mayContainFolderLinks(content)) return unchanged;

  const kind = viewKind(options);

  if (!kind) return unchanged;

  const ctx = {
    src: content,
    edits: [],
    patterns: hostPatterns(options.hosts),
    depth: 0,
  };

  try {
    if (kind === "css") {
      scanCss(ctx, 0, content.length);
    } else {
      scanHtml(ctx, 0, content.length);
    }
  } catch (err) {
    // A bug here must never stop a view rendering: the links just stay
    // as written.
    console.error("resolveFolderLinks failed for", options.viewName, err);
    return unchanged;
  }

  if (!ctx.edits.length) return unchanged;

  ctx.edits.sort((a, b) => a.start - b.start);

  let output = "";
  let cursor = 0;
  const targets = new Set();

  for (const edit of ctx.edits) {
    if (edit.start < cursor) continue;

    output +=
      content.slice(cursor, edit.start) + "{{#cdn}}" + edit.target + "{{/cdn}}";
    cursor = edit.end;
    targets.add(edit.target.replace(/^\//, ""));
  }

  output += content.slice(cursor);

  // Never hand back a copy that doesn't parse
  try {
    Mustache.parse(output);
  } catch (err) {
    return unchanged;
  }

  return { content: output, targets: Array.from(targets).sort() };
}

// An inline partial (a string in a view's partials, from package.json) has no
// view name of its own, so it is wrapped as HTML. getPartials renders the
// result and updateCdnManifest collects its targets with this same call.
function wrapInlinePartial(content, hosts) {
  return wrapFolderLinks(content, { viewName: "partial.html", hosts });
}

function mayContainFolderLinks(content) {
  return (
    typeof content === "string" &&
    content.length > 0 &&
    CANDIDATE.test(content) &&
    !DELIMITER_CHANGE.test(content)
  );
}

// Walks template locals (package.json "locals", a view's own locals) and
// calls fn(target, value) for every string value which is wholly a folder
// link (see folderTarget). Returns a copy of locals with each such value
// replaced by fn's return value (when it is a string), or locals itself if
// nothing was replaced: updateCdnManifest uses it to collect targets, the
// render to swap in CDN URLs (blog/render/folderManifestUrl). Bounded, since
// locals are authored.
const LOCALS_MAX_DEPTH = 4;
const LOCALS_MAX_VALUES = 500;

function mapFolderLocals(locals, hosts, fn) {
  const patterns = hostPatterns(hosts);
  let seen = 0;

  function walk(value, depth) {
    if (typeof value === "string") {
      if (++seen > LOCALS_MAX_VALUES) return value;
      if (value.indexOf(".") === -1) return value;

      const target = folderTargetFor(patterns, value);
      if (!target) return value;

      const replacement = fn(target, value);
      return typeof replacement === "string" ? replacement : value;
    }

    if (!value || typeof value !== "object" || depth >= LOCALS_MAX_DEPTH)
      return value;

    let copy = null;

    for (const k of Object.keys(value)) {
      const mapped = walk(value[k], depth + 1);

      if (mapped !== value[k]) {
        if (!copy)
          copy = Array.isArray(value) ? value.slice() : Object.assign({}, value);
        copy[k] = mapped;
      }
    }

    return copy || value;
  }

  return walk(locals, 0);
}

module.exports = resolveFolderLinks;
module.exports.wrapFolderLinks = wrapFolderLinks;
module.exports.wrapInlinePartial = wrapInlinePartial;
module.exports.mayContainFolderLinks = mayContainFolderLinks;
module.exports.folderTarget = folderTarget;
module.exports.mapFolderLocals = mapFolderLocals;
