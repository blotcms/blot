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

module.exports = {
  htmlExtRegex,
  fileExtRegex,
  parseSrcset,
  hostPatterns,
  stripOwnHost,
  pathPartOf,
};
