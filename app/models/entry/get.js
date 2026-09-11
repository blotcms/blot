var ensure = require("helper/ensure");
var type = require("helper/type");
var config = require("config");

var redis = require("models/client");
var key = require("./key");
var entryKey = key.entry;
var entryHashKey = key.entryHash;
var format = require("./format");

var Entry = require("./instance");

// get(blogID, entryIDs, [fields], callback)
//
// entryIDs may be a single path (string) or an array of paths.
//
// By default this reads the legacy JSON string key, exactly as it always
// has. When config.redis.readEntriesFromHash is enabled it reads from the
// per-entry Redis hash instead (falling back to the JSON string for entries
// the backfill has not reached yet) and honours an optional `fields`
// argument:
//   - undefined  -> whole entry
//   - "title"    -> just that field; for a single-entry lookup the raw value
//                   is passed to the callback instead of an Entry
//   - ["a", "b"] -> an Entry carrying only those fields (plus id)
//
// `fields` is ignored while reads are still on the JSON string, so callers
// can be wired up ahead of the cutover without changing behaviour.
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

  ensure(entryIDs, "array");

  if (config.redis.readEntriesFromHash) {
    return getFromHash(blogID, entryIDs, single, fields, callback);
  }

  return getFromString(blogID, entryIDs, single, callback);
};

// --- Legacy path: one MGET over the JSON string keys. -----------------------

function getFromString(blogID, entryIDs, single, callback) {
  var stringKeys = entryIDs.map(function (entryID) {
    return entryKey(blogID, entryID);
  });

  redis
    .mGet(stringKeys)
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
}

// --- Hash path: HMGET/HGETALL per entry, JSON-string fallback. --------------

function getFromHash(blogID, entryIDs, single, fields, callback) {
  var scalarMode = single && typeof fields === "string";

  var fieldList = null;
  if (typeof fields === "string") {
    fieldList = [fields];
  } else if (Array.isArray(fields) && fields.length) {
    fieldList = fields.slice();
  }

  // Every non-scalar narrowed result carries id so callers can correlate the
  // returned entries with their input positions (missing entries are filtered
  // out of the array). scalarMode returns a bare value, so it skips this.
  if (fieldList && !scalarMode && fieldList.indexOf("id") === -1) {
    fieldList.push("id");
  }

  var hashKeys = entryIDs.map(function (entryID) {
    return entryHashKey(blogID, entryID);
  });

  // Issued directly (not via redis.multi()/exec()) so node-redis's
  // client-side cache (see app/models/redis.js) can serve repeat reads
  // locally - a MULTI/EXEC transaction bypasses that cache entirely, since
  // transaction-queued commands aren't tracked by it. These calls still
  // avoid N sequential round trips: firing them all in the same tick lets
  // node-redis auto-pipeline the writes.
  var reads = hashKeys.map(function (hashKey) {
    return fieldList ? redis.hmGet(hashKey, fieldList) : redis.hGetAll(hashKey);
  });

  Promise.all(reads)
    .then(function (hashResults) {
      // Which entries have no hash yet and need the legacy JSON key?
      var missingIndexes = [];

      hashResults.forEach(function (result, index) {
        if (!hashPresent(result, fieldList)) missingIndexes.push(index);
      });

      if (!missingIndexes.length) {
        return hashResults.map(function (result) {
          return toPayload(result, fieldList);
        });
      }

      var stringKeys = missingIndexes.map(function (index) {
        return entryKey(blogID, entryIDs[index]);
      });

      return redis.mGet(stringKeys).then(function (jsonResults) {
        var byIndex = {};
        missingIndexes.forEach(function (originalIndex, i) {
          byIndex[originalIndex] = jsonResults && jsonResults[i];
        });

        return hashResults.map(function (result, index) {
          if (byIndex[index] !== undefined && byIndex[index] !== null) {
            var parsed = parseJSON(byIndex[index]);
            // The JSON string holds the whole entry; honour the narrowing the
            // caller asked for so a fallback entry looks like a hash one.
            return fieldList ? projectToFields(parsed, fieldList) : parsed;
          }
          return toPayload(result, fieldList);
        });
      });
    })
    .then(function (entries) {
      if (!entries) return;

      if (scalarMode) {
        var only = entries[0];
        if (only === undefined || only === null) return callback();
        return callback(only[fields]);
      }

      entries = entries.filter(function (entry) {
        return entry;
      });

      entries = entries.map(function (entry) {
        return entry instanceof Entry ? entry : new Entry(entry);
      });

      if (single) {
        if (!entries[0]) return callback();
        return callback(entries[0]);
      }

      return callback(entries);
    })
    .catch(function (err) {
      console.error(err);

      if (single) return callback();

      return callback([]);
    });
}

// Convert one hash read (object from HGETALL or array from HMGET) into a
// plain, type-coerced object - or null when there was nothing there.
function toPayload(result, fieldList) {
  if (!result) return null;

  var raw;

  if (Array.isArray(result)) {
    raw = {};
    fieldList.forEach(function (field, i) {
      if (result[i] !== null && result[i] !== undefined) raw[field] = result[i];
    });
  } else {
    raw = result;
  }

  if (!Object.keys(raw).length) return null;

  return format.deserialize(raw);
}

function parseJSON(value) {
  try {
    return JSON.parse(value);
  } catch (e) {
    console.error("entry.get: failed to parse JSON entry", e);
    return null;
  }
}

// Reduce a whole entry object to just the requested fields - used when a
// narrowed hash read falls back to the full JSON string.
function projectToFields(entry, fieldList) {
  if (!entry || typeof entry !== "object") return entry;

  var out = {};
  fieldList.forEach(function (field) {
    if (entry[field] !== undefined) out[field] = entry[field];
  });
  return out;
}

// HGETALL returns {} for a missing hash; HMGET returns [null, null, ...]. Any
// non-null field means the hash exists (an existing entry always has scalar
// fields like path/created set, so "all null" is a genuine miss).
function hashPresent(result, fieldList) {
  if (!result) return false;

  if (fieldList) {
    return result.some(function (value) {
      return value !== null && value !== undefined;
    });
  }

  return Object.keys(result).length > 0;
}
