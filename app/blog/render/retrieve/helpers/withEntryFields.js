var config = require("config");

// A list fetch narrowed to the referenced fields (see entryFieldList) drops
// the heavy fields the template does not render. But renderLocals re-evaluates
// every string in a local as Mustache against the whole local, so an entry
// whose own retained content contains "{{...}}" - e.g. a title that is
// literally "{{#allEntries}}{{summary}}{{/allEntries}}" - can reference a
// heavy field we skipped. projectEntryFields cancels projection when it spots
// this, but it cannot restore fields that were never fetched, so we refetch
// the whole list instead.
//
// Only relevant once config.redis.readEntriesFromHash is on; until then the
// "narrow" fetch already returns whole entries and this is a straight
// pass-through with no extra round trip.
//
//   withEntryFields(
//     function (cb) { Entries.getAll(id, { fields: fields }, cb); }, // narrow
//     function (cb) { Entries.getAll(id, cb); },                     // full
//     done
//   );
module.exports = function withEntryFields(narrowFetch, fullFetch, callback) {
  if (!config.redis.readEntriesFromHash) return narrowFetch(callback);

  narrowFetch(function (entries) {
    if (hasMustache(entries)) return fullFetch(callback);
    return callback(entries);
  });
};

// True if any string field of any entry contains a Mustache tag.
function hasMustache(entries) {
  var list = Array.isArray(entries) ? entries : entries ? [entries] : [];

  for (var i = 0; i < list.length; i++) {
    var entry = list[i];
    if (!entry || typeof entry !== "object") continue;

    for (var key in entry) {
      if (!Object.prototype.hasOwnProperty.call(entry, key)) continue;
      var value = entry[key];
      if (typeof value === "string" && value.indexOf("{{") !== -1) return true;
    }
  }

  return false;
}

module.exports.hasMustache = hasMustache;
