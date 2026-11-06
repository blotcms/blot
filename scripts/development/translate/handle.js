// Derive a Blot blog handle from a website URL.
//
// The handle must be stable for a given URL: re-run detection looks the site up
// by handle, so a non-deterministic derivation would silently create a second
// site instead of continuing the first.
//
// Blot's rules (app/models/blog/validate/handle.js): lowercase, /^[a-zA-Z0-9]+$/,
// 2-70 characters, not in banned.txt, not already taken.

var MIN_LENGTH = 2;
var MAX_LENGTH = 70;

// Subdomains that say nothing about which site this is.
var IGNORED_SUBDOMAINS = ["www", "web", "en", "m", "blog"];

// Suffixes stripped from the end of a hostname. Longest first so that
// "co.uk" wins over "uk".
var IGNORED_SUFFIXES = [
  "co.uk",
  "org.uk",
  "ac.uk",
  "com.au",
  "co.nz",
  "co.jp",
  "com.br",
  "github.io",
  "gitlab.io",
  "netlify.app",
  "vercel.app",
  "pages.dev",
  "wordpress.com",
  "substack.com",
  "medium.com",
  "blogspot.com",
  "squarespace.com",
  "tumblr.com",
  "blot.im",
];

function alnum(value) {
  return (
    String(value || "")
      .toLowerCase()
      .normalize("NFKD")
      // Drop combining marks so accented characters keep their base letter
      // (José -> jose) rather than vanishing entirely.
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]/g, "")
  );
}

function stripSuffix(hostname) {
  for (var i = 0; i < IGNORED_SUFFIXES.length; i++) {
    var suffix = "." + IGNORED_SUFFIXES[i];
    if (hostname.length > suffix.length && hostname.endsWith(suffix)) {
      return hostname.slice(0, -suffix.length);
    }
  }

  // Otherwise drop a single trailing TLD label, but only if something is left.
  var labels = hostname.split(".");
  if (labels.length > 1) labels.pop();
  return labels.join(".");
}

var HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

function parseHostAndPath(url) {
  var input = String(url || "").trim();

  if (!input) return null;

  // Only prepend a scheme when one is genuinely absent. Doing it unconditionally
  // turns "https://" into "https://https://", which parses with hostname "https".
  var candidate = HAS_SCHEME.test(input) ? input : "https://" + input;
  var parsed;

  try {
    parsed = new URL(candidate);
  } catch (e) {
    return null;
  }

  if (!parsed.hostname) return null;

  // URL punycodes international hostnames (josé.com -> xn--jos-dma.com), which
  // would fold to "xnjosdma". Take the host from the raw string instead so NFKD
  // can do its job, and fall back to the parsed value if that yields nothing.
  var rawHost = candidate
    .replace(HAS_SCHEME, "")
    .split(/[/?#]/)[0]
    .split("@")
    .pop()
    .replace(/:\d+$/, "")
    .replace(/\.$/, "")
    .toLowerCase();

  return {
    hostname: rawHost || parsed.hostname.replace(/\.$/, "").toLowerCase(),
    pathname: parsed.pathname || "/",
  };
}

// Derive the base handle. Does not check availability or the banned list —
// callers pass the result through resolve() for that.
function deriveHandle(url) {
  var parts = parseHostAndPath(url);

  if (!parts) return "";

  var labels = stripSuffix(parts.hostname)
    .split(".")
    .filter(function (label) {
      return label && IGNORED_SUBDOMAINS.indexOf(label) === -1;
    });

  var handle = alnum(labels.join(""));

  // A path segment disambiguates hosts that serve many sites, and rescues the
  // case where stripping subdomains left nothing (e.g. https://www.com/foo).
  var segment = parts.pathname.split("/").filter(Boolean)[0];

  if (segment && (!handle || handle.length < MIN_LENGTH)) {
    handle = alnum(handle + segment);
  }

  if (handle.length < MIN_LENGTH) return "";

  return handle.slice(0, MAX_LENGTH);
}

// Append a numeric suffix without exceeding the length limit.
function withSuffix(base, n) {
  if (n <= 1) return base.slice(0, MAX_LENGTH);
  var suffix = String(n);
  return base.slice(0, MAX_LENGTH - suffix.length) + suffix;
}

// Walk candidates until one is free. `isTaken(handle)` returns truthy for
// handles that are unavailable — banned, or already owned by another site.
function resolve(base, isTaken, limit) {
  limit = limit || 100;

  for (var n = 1; n <= limit; n++) {
    var candidate = withSuffix(base, n);
    if (!isTaken(candidate)) return candidate;
  }

  return null;
}

module.exports = deriveHandle;
module.exports.deriveHandle = deriveHandle;
module.exports.withSuffix = withSuffix;
module.exports.resolve = resolve;
module.exports.MIN_LENGTH = MIN_LENGTH;
module.exports.MAX_LENGTH = MAX_LENGTH;

if (require.main === module) {
  var handle = deriveHandle(process.argv[2]);

  if (!handle) {
    console.error("Could not derive a handle from: " + process.argv[2]);
    process.exit(1);
  }

  process.stdout.write(handle);
}
