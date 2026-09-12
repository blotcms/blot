var ensure = require("helper/ensure");
var type = require("helper/type");

var redis = require("models/client");
var entryKey = require("./key").entry;

var Entry = require("./instance");

// get(blogID, entryIDs, [fields], callback)
//
// entryIDs may be a single path (string) or an array of paths. `fields` is
// accepted for call-site compatibility but ignored - every entry is read in
// full with a single MGET over the JSON string keys.
module.exports = function (blogID, entryIDs, fields, callback) {
  if (typeof fields === "function") {
    callback = fields;
    fields = undefined;
  }

  ensure(blogID, "string").and(callback, "function");

  var single = false;

  // Empty list of entry IDs, leave now!
  if (type(entryIDs, "array") && !entryIDs.length) {
    return callback([]);
  }

  // We're only getting one entry now...
  if (type(entryIDs, "string")) {
    single = true;
    entryIDs = [entryIDs];
  }

  entryIDs = entryIDs.map(function (entryID) {
    return entryKey(blogID, entryID);
  });

  ensure(entryIDs, "array");

  redis
    .mGet(entryIDs)
    .then(function (entries) {
      entries = entries || [];

      entries = entries.filter(function (entry) {
        return entry;
      });

      entries = entries.map(function (entry) {
        return new Entry(JSON.parse(entry)); // return value
      });

      if (single) {
        entries = entries[0];
      }

      if (single && !entries) return callback();

      return callback(entries);
    })
    .catch(function (err) {
      console.error(err);

      if (single) return callback();

      return callback([]);
    });
};
