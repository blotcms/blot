// Entry-list locals (allEntries, recentEntries, archives, posts, tagged...)
// historically loaded every entry in full, including the rendered HTML body.
// parseTemplate now records which entry fields a view actually references in
// retrieve metadata, e.g.
//
//   retrieve.allEntries === { fields: { title: true, url: true } }
//
// When that metadata is present we can safely drop the large, unreferenced
// body fields from each entry before they enter res.locals. This keeps
// list/archive pages from holding megabytes of entry HTML in memory for
// content the template never renders.
//
// Backwards compatibility:
//   - Views whose retrieve metadata has not been recalculated yet still store
//     `allEntries: true` (or `{ length: true }`). Without an explicit `fields`
//     map we cannot know which fields are safe to drop, so we strip nothing
//     and behaviour is identical to before.
//   - Only the fields in HEAVY_FIELDS are ever removed. Everything the render
//     pipeline relies on (url, tags, dateStamp, metadata, thumbnail, ...) is
//     always kept, so augment() and friends keep working.

// Large, render-only fields. None of these are read by the render pipeline
// itself (blog/render/load/augment.js, locals.js, ...), only by templates.
var HEAVY_FIELDS = ["html", "body", "teaser", "teaserBody", "summary"];

// Given the full retrieve object and the alias keys a retrieve module answers
// to (e.g. ["allEntries", "all_entries"]), work out the union of referenced
// entry fields. Returns null when projection must be skipped: either no alias
// is referenced, or an alias is referenced without a `fields` map (legacy
// boolean metadata, or non-field access such as `allEntries.length`).
function resolveFields(retrieve, keys) {
  if (!retrieve || typeof retrieve !== "object") return null;

  var referenced = false;
  var merged = {};

  for (var i = 0; i < keys.length; i++) {
    var value = retrieve[keys[i]];

    if (value === undefined) continue;

    referenced = true;

    if (
      !value ||
      typeof value !== "object" ||
      !value.fields ||
      typeof value.fields !== "object"
    ) {
      return null;
    }

    Object.keys(value.fields).forEach(function (field) {
      merged[field] = true;
    });
  }

  return referenced ? merged : null;
}

// Mutates the entries in place, deleting heavy fields the template does not
// reference. Accepts either a list of entries (allEntries, posts, ...) or a
// single entry object (latestEntry). Entries handed to retrieve modules are
// always freshly parsed (or freshly cloned, in the case of the posts/tagged
// caches) so in-place deletion never touches shared or frozen instances.
// Returns the same value it was given for convenience.
function projectEntryFields(entries, retrieve, keys) {
  var isList = Array.isArray(entries);
  var list = isList ? entries : entries ? [entries] : [];

  if (!list.length) return entries;

  var fields = resolveFields(retrieve, Array.isArray(keys) ? keys : [keys]);

  if (!fields) return entries;

  var strip = HEAVY_FIELDS.filter(function (field) {
    return !fields[field];
  });

  if (!strip.length) return entries;

  // A Blot entry's own content can carry Mustache that renderLocals evaluates
  // after retrieval - e.g. an entry whose `html` (or even a plain `title`) is
  // "{{#allEntries}}{{{summary}}}{{/allEntries}}". That markup is rendered
  // against the whole retrieved local, not just its own entry, and renderLocals
  // walks every string property, not only the heavy ones. So if ANY retained
  // string field of ANY entry contains template tags, we can't know which
  // fields are safe to drop - bail out of projection for the whole list.
  //
  // KNOWN LIMITATION: this only sees the entries in *this* local. An entry
  // here whose markup references a different retrieve local's heavy field
  // (e.g. a post body containing "{{latestEntry.summary}}") does not stop
  // latest_entry from projecting `summary` away, because each retrieve module
  // runs independently. Closing that needs projection to move to a single
  // post-retrieval pass in blog/render/retrieve/index.js - tracked as a
  // follow-up. It is rare and fails safe-ish (empty fragment, not data loss).
  for (var i = 0; i < list.length; i++) {
    if (entryHasMustache(list[i], strip)) return entries;
  }

  for (var k = 0; k < list.length; k++) {
    var entry = list[k];

    if (!entry || typeof entry !== "object") continue;

    for (var j = 0; j < strip.length; j++) {
      if (entry[strip[j]] !== undefined) delete entry[strip[j]];
    }
  }

  return entries;
}

// True if any string field that will survive projection contains a Mustache
// tag. `strip` is the set of fields about to be removed - those are ignored
// (they won't be around to be re-rendered).
function entryHasMustache(entry, strip) {
  if (!entry || typeof entry !== "object") return false;

  for (var key in entry) {
    if (!Object.prototype.hasOwnProperty.call(entry, key)) continue;
    if (strip.indexOf(key) !== -1) continue;
    var value = entry[key];
    if (typeof value === "string" && value.indexOf("{{") !== -1) return true;
  }

  return false;
}

projectEntryFields.HEAVY_FIELDS = HEAVY_FIELDS;
projectEntryFields.resolveFields = resolveFields;

module.exports = projectEntryFields;
