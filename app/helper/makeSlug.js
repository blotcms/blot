const ensure = require("helper/ensure");
const MAX_LENGTH = 100;

// This must always return a string but it can be empty
module.exports = function makeSlug(string) {
  var words;
  var trimmed = "";

  ensure(string, "string");

  var slug = "";

  slug = string;

  // Remove query sluging
  if (slug.indexOf("?=") > -1) slug = slug.slice(0, slug.indexOf("?="));

  slug = sliceWithoutSplittingSurrogates(slug.trim(), MAX_LENGTH + 10)

    // Removes 'object replacement character' which unexpectedly
    // entered a file created on Ulysses. Perhaps an embedded image?
    .split(decodeURIComponent("%EF%BF%BC"))
    .join("")

    .toLowerCase()

    // remove common punction, basically everything except & _ and - /
    // Should we be stripping all &encoded; characters?
    .replace(/\%/g, "-percent")
    .replace(/&amp;/g, "and")
    .replace(/&nbsp;/g, " ")
    .replace(/&thinsp;/g, " ")
    .replace(/&mdash;/g, "-")

    // maps don't to dont, won't to wont
    // shouldn't to shouldnt
    .replace(/n['’]t/g, "nt")

    // maps i'm to im
    .replace(/i['’]m/g, "im")

    // maps she'd and he'd
    .replace(/e['’]d/g, "ed")

    // o'clock
    .replace(/o['’]c/g, "oc")

    // you're
    .replace(/u['’]r/g, "ur")

    // we'll
    .replace(/e['’]l/g, "el")

    // maps it's
    .replace(/t['’]s/g, "ts")

    // maps they've
    .replace(/y['’]v/g, "yv")
    
    // maps apple's to apples
    .replace(/['’]s/g, "s")

    .replace(/→/g, "to")
    .replace(/←/g, "from")
    .replace(/\./g, "-")
    .replace(
      /[\«\»\“\”\‘\–\’\`\~\!\@\#\$\%\^\&\*\(\)\+\=\\\|\]\}\{\[\'\"\;\:\?>\.<\,]/g,
      "-"
    )
    .replace(/[^[:alnum:]0-9_-\s]/g, "") // remove invalid chars
    .replace(/\s+/g, "-") // collapse whitespace and replace by -
    .replace(/-+/g, "-"); // collapse dashes

  words = slug.split("-");
  trimmed = words.shift();

  for (var x = 0; x < words.length; x++) {
    if (trimmed.length + words[x].length > MAX_LENGTH) break;

    trimmed += "-" + words[x];
  }

  slug = trimmed;

  // remove internal leading and trailing hyphens, e.g.
  // /-foo-/bar -> /foo/bar
  slug = slug
    .split("/")
    .map((str) => trimLeadingAndTrailing(str, ["-"]))
    .join("/");

  slug = trimLeadingAndTrailing(slug, ["-", "/"]);

  if (slug === "-") slug = "";

  slug = encodeURI(slug);

  slug = slug || "";

  return slug;
};

// Truncate by UTF-16 length without splitting a surrogate pair, which
// would make encodeURI throw URIError.
function sliceWithoutSplittingSurrogates(str, maxUnits) {
  if (str.length <= maxUnits) return str;
  let end = maxUnits;
  const last = str.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return str.slice(0, end);
}

function trimLeadingAndTrailing(str, characters) {
  while (str.length > 1 && characters.indexOf(str[0]) > -1) str = str.slice(1);

  while (str.length > 1 && characters.indexOf(str.slice(-1)) > -1)
    str = str.slice(0, -1);

  return str;
}
