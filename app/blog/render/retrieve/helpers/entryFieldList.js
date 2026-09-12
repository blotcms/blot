// Turn retrieve projection metadata into the list of entry fields a list
// fetch actually needs, so models/entry/get.js can HMGET just those instead
// of loading every entry's rendered HTML.
//
//   entryFieldList(retrieve, ["allEntries", "all_entries"])
//     -> ["id", "guid", "url", ..., "title"]   (every non-heavy field + the
//                                               heavy fields the view renders)
//     -> null                                   (projection must be skipped;
//                                               caller should fetch whole
//                                               entries)
//
// This mirrors projectEntryFields exactly: only the HEAVY_FIELDS are ever
// dropped, everything the render pipeline relies on (url, tags, dateStamp,
// metadata, thumbnail, ...) is always fetched. When the metadata is legacy
// (a bare `allEntries: true`, or non-field access like `allEntries.length`)
// resolveFields returns null and so do we.
//
// The narrowing only actually happens once config.redis.readEntriesFromHash
// is on - until then models/entry/get ignores the field list and returns
// whole entries, and projectEntryFields does the in-memory strip as before.
//
// An entry whose own retained content carries Mustache could still reference a
// heavy field the narrowed read skipped; the retrieve modules guard that with
// lib/withEntryFields (refetch the whole list when that happens).

var model = require("models/entry").model;
var projectEntryFields = require("./projectEntryFields");

var HEAVY_FIELDS = projectEntryFields.HEAVY_FIELDS;

var NON_HEAVY_FIELDS = Object.keys(model).filter(function (field) {
  return HEAVY_FIELDS.indexOf(field) === -1;
});

module.exports = function entryFieldList(retrieve, keys) {
  var referenced = projectEntryFields.resolveFields(
    retrieve,
    Array.isArray(keys) ? keys : [keys]
  );

  if (!referenced) return null;

  var fields = NON_HEAVY_FIELDS.slice();

  HEAVY_FIELDS.forEach(function (field) {
    if (referenced[field]) fields.push(field);
  });

  return fields;
};

module.exports.NON_HEAVY_FIELDS = NON_HEAVY_FIELDS;
