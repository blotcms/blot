var normalize = require("./normalize");

// The tags an entry is listed under: each normalized tag (a slug, so it can be
// part of a URL) with the entry's first spelling of it. A hidden entry is
// listed under none, so it doesn't show up on the tag search results page.
//
// Returns { tags: [normalized, ...], names: [pretty, ...] }, in the entry's
// order, one per normalized tag.
module.exports = function forEntry(entry) {
  var tags = [];
  var names = [];

  if (shouldHide(entry)) return { tags: tags, names: names };

  var seen = Object.create(null);

  entry.tags.forEach(function (tag) {
    if (!(tag && tag.trim && tag.trim().length)) return;

    var normalized = normalize(tag);

    if (seen[normalized]) return;

    seen[normalized] = true;
    tags.push(normalized);
    names.push(tag);
  });

  return { tags: tags, names: names };
};

// we need a better way to determine if we should ignore the entry (i.e. if has an underscore in its path)
function shouldHide(entry) {
  return (
    entry.deleted ||
    entry.draft ||
    entry.scheduled ||
    entry.page ||
    entry.menu ||
    entry.path.split("/").filter(function (i) {
      return i[0] === "_";
    }).length
  );
}
