const async = require("async");
const client = require("models/client");
const entryKey = require("models/entry/key").entry;
const folderPostFolder = require("sync/update/folderPostSourceFolder");

// Fix()'s checks (entry-ghosts, tag-ghosts, list-ghosts) each used to read a
// blog's entries in full from Redis independently - entry-ghosts scans
// every entry, list-ghosts re-reads entries by id, and tag-ghosts re-reads
// an entry once per tag it belongs to (up to 8x for a popular entry). On
// 2026-09-28 that flood of full-content reads on the single shared Redis
// connection queued behind lock heartbeats for long enough to crash the
// process.
//
// This cache is created once per Fix() run (see fix/index.js) and shared
// across those checks so that:
//   - an id another check (or an earlier batch in the same check) already
//     resolved this run is answered for free, no Redis round trip at all
//   - an id nobody has resolved yet is still fetched with one MGET per
//     BATCH_SIZE ids instead of one GET per id
//
// Only small per-entry fields are ever retained - never the full parsed
// entry (content included) - so memory stays bounded to the cache's id
// count, not to the blog's aggregate content size.
//
// A check that mutates an entry (Entry.set / Entry.drop) MUST call
// invalidate()/set() so a later check in the same run sees the corrected
// state instead of stale cached metadata.
var BATCH_SIZE = 100;

function pickFields(entry) {
  if (!entry) return null;
  return {
    id: entry.id,
    path: entry.path,
    deleted: !!entry.deleted,
    dateStamp: entry.dateStamp,
    multiFolder: folderPostFolder(entry),
  };
}

module.exports = function createEntryCache(blogID) {
  var cache = new Map(); // requested id/path -> fields object, or null if not found

  function get(id) {
    return cache.get(id);
  }

  function has(id) {
    return cache.has(id);
  }

  function set(id, fields) {
    cache.set(id, fields);
  }

  function invalidate(id) {
    cache.delete(id);
  }

  function fetchBatch(ids, callback) {
    var keys = ids.map(function (id) {
      return entryKey(blogID, id);
    });

    client
      .mGet(keys)
      .then(function (values) {
        (values || []).forEach(function (value, i) {
          var id = ids[i];

          if (!value) {
            cache.set(id, null);
            return;
          }

          var entry;
          try {
            entry = JSON.parse(value);
          } catch (e) {
            cache.set(id, null);
            return;
          }

          cache.set(id, pickFields(entry));
        });

        // Yield so V8 gets a chance to reclaim this batch's full JSON
        // strings before the next batch is parsed.
        setImmediate(callback);
      })
      .catch(callback);
  }

  // getMany(ids, callback(err, resultsByID))
  // resultsByID is a Map from each requested id to its cached fields (or
  // null when no entry exists for that id).
  function getMany(ids, callback) {
    var unique = Array.from(new Set(ids));
    var missing = unique.filter(function (id) {
      return !cache.has(id);
    });

    var batches = [];
    for (var i = 0; i < missing.length; i += BATCH_SIZE) {
      batches.push(missing.slice(i, i + BATCH_SIZE));
    }

    async.eachSeries(batches, fetchBatch, function (err) {
      if (err) return callback(err);

      var results = new Map();
      unique.forEach(function (id) {
        results.set(id, cache.get(id));
      });
      callback(null, results);
    });
  }

  return {
    get: get,
    has: has,
    set: set,
    invalidate: invalidate,
    getMany: getMany,
  };
};
