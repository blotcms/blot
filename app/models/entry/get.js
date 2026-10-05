var ensure = require("helper/ensure");
var type = require("helper/type");

var redis = require("models/client");
var entryKey = require("./key").entry;

var Entry = require("./instance");

// Entries are read in full, so one MGET over a whole catalog (e.g. every
// entry of a blog, for archives) returns tens of MB that are then parsed
// in a single tick - which blocks the event loop for every other request
// served by this process. Reading BATCH_SIZE entries at a time and yielding
// between batches lets those requests run in between.
var BATCH_SIZE = 100;

// get(blogID, entryIDs, [fields], callback)
//
// entryIDs may be a single path (string) or an array of paths. `fields` is
// accepted for call-site compatibility but ignored - every entry is read in
// full with an MGET over the JSON string keys.
function get(blogID, entryIDs, fields, callback) {
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

  readInBatches(entryIDs)
    .then(function (entries) {
      if (single) {
        entries = entries[0];
      }

      if (single && !entries) return callback();

      return callback(entries);
    })
    .catch(function (err) {
      console.error(err);

      // The error rides along as a second argument so a caller that caches
      // the result can tell this apart from entries that don't exist - see
      // getByUrl.js. Existing callers only read the first.
      if (single) return callback(undefined, err);

      return callback([], err);
    });
}

// Resolves the entries that exist, in the order requested. Rejects if any
// batch fails, so a partial list is never mistaken for the whole one.
async function readInBatches(keys) {
  var entries = [];

  for (var i = 0; i < keys.length; i += BATCH_SIZE) {
    // Let other requests run before the next batch is read and parsed
    if (i > 0) await new Promise(setImmediate);

    var values = (await redis.mGet(keys.slice(i, i + BATCH_SIZE))) || [];

    values.forEach(function (value) {
      if (value) entries.push(new Entry(JSON.parse(value)));
    });
  }

  return entries;
}

module.exports = get;

// Tests lower this to exercise batching without hundreds of entries
Object.defineProperty(module.exports, "BATCH_SIZE", {
  get: function () {
    return BATCH_SIZE;
  },
  set: function (size) {
    BATCH_SIZE = size;
  },
});
