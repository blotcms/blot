// Helpers shared by request-time link rewriting (html.js, css.js) and the
// build-time folderAssets plugin, so the two can't drift apart.
const htmlExtRegex = /\.html$/;
const fileExtRegex = /[^/]*\.[^/]*$/;

const parseSrcset = (value) => {
  if (typeof value !== "string") {
    return null;
  }

  const candidates = value.split(",");
  const parsed = [];

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed) {
      return null;
    }

    const parts = trimmed.split(/\s+/);
    const url = parts.shift();
    if (!url) {
      return null;
    }

    parsed.push({
      url,
      descriptor: parts.length ? parts.join(" ") : "",
    });
  }

  return parsed;
};

const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Matches an absolute URL on one of the blog's own hosts
// (https://blog.example.com/photo.jpg, //blog.example.com/photo.jpg), up to
// the end of the host.
const hostPatterns = (hosts) =>
  (hosts || []).map(
    (host) => new RegExp(`^(?:https?:)?//${escapeRegex(host)}(?=[/?#]|$)`, "i")
  );

// Strips the blog's own host from an absolute URL, leaving a path that is
// then treated like any other folder-relative link. Returns the value
// unchanged if it isn't on one of the blog's hosts.
const stripOwnHost = (patterns, value) => {
  for (const pattern of patterns) {
    if (pattern.test(value)) return value.replace(pattern, "") || "/";
  }
  return value;
};

// The path of a link without its ?query or #hash.
const pathPartOf = (value) => {
  const cutIndex = value.search(/[#?]/);
  return cutIndex === -1 ? value : value.slice(0, cutIndex);
};

// Folder URLs (%%BLOT_CDN%%/folder/v-<version>/<blogID><path>) are built
// from the decoded, case-corrected path on disk, so percent-encode each
// segment: a literal space would split a srcset candidate in two, a literal
// '%', '#' or '?' would be misread by the browser or the CDN route, and
// encodeURIComponent's leftovers (! ' ( ) *) can end an unquoted CSS url()
// or a quoted attribute.
const encodeFolderPath = (path) =>
  path
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (char) => "%" + char.charCodeAt(0).toString(16).toUpperCase()
      )
    )
    .join("/");

// Decodes the path portion of a folder link. Split off any ?query and
// #hash first, so an encoded '#' or '?' in a file name isn't mistaken for
// one. A path that isn't valid percent-encoding (e.g. '/100% luck.jpg' in a
// link baked before paths were encoded) is returned unchanged.
const decodeFolderPath = (path) => {
  try {
    return decodeURIComponent(path);
  } catch (err) {
    return path;
  }
};

// A {{#cdn}} target the template parser and the manifest builder will accept
// (no whitespace, backslash, NUL, braces, ".." segment or "//", and short
// enough). Shared by util/resolveFolderLinks (which only wraps safe links)
// and retrieve/cdn.js (which leaves unsafe targets exactly as written).
const isSafeCdnTarget = (target) =>
  typeof target === "string" &&
  target.length <= 255 &&
  !/[\s\\\0{}]|\.\.|\/\//.test(target);

module.exports = {
  isSafeCdnTarget,
  htmlExtRegex,
  fileExtRegex,
  parseSrcset,
  hostPatterns,
  stripOwnHost,
  pathPartOf,
  encodeFolderPath,
  decodeFolderPath,
};
