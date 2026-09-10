// Translates between Entry objects and the flat string map stored in an entry
// Redis hash (see ./key.js `entryHash`).
//
//   serialize(entry)      -> { title: "Hi", tags: '["a"]', menu: "false", ... }
//   deserialize(hashData) -> { title: "Hi", tags: ["a"], menu: false, ... }
//
// Serialization reuses the shared redis hash serializer (booleans -> "true"/
// "false", numbers -> String, arrays/objects -> JSON). Deserialization is
// driven by ./model.js so every field is coerced back to the type the rest of
// the entry pipeline expects. Fields absent from the hash are simply omitted
// from the result - callers (models/entry/set.js, the render pipeline) already
// tolerate partial entries and fill their own defaults.

var serializeRedisHashValues = require("models/redisHashSerializer");
var model = require("./model");

function serialize(entry) {
  return serializeRedisHashValues(entry || {});
}

function deserializeField(field, raw) {
  if (raw === undefined || raw === null) return undefined;

  var expectedType = model[field];

  // Unknown field - keep the raw string rather than guessing.
  if (!expectedType) return raw;

  if (expectedType === "string") return raw;

  if (expectedType === "number") {
    var number = Number(raw);
    return Number.isNaN(number) ? undefined : number;
  }

  if (expectedType === "boolean") return raw === "true";

  if (expectedType === "array") {
    try {
      var parsedArray = JSON.parse(raw);
      return Array.isArray(parsedArray) ? parsedArray : [];
    } catch (e) {
      return [];
    }
  }

  if (expectedType === "object") {
    try {
      var parsedObject = JSON.parse(raw);
      return parsedObject && typeof parsedObject === "object" && !Array.isArray(parsedObject)
        ? parsedObject
        : {};
    } catch (e) {
      return {};
    }
  }

  return raw;
}

function deserialize(hashData) {
  var output = {};

  Object.keys(hashData || {}).forEach(function (field) {
    var value = deserializeField(field, hashData[field]);
    if (value !== undefined) output[field] = value;
  });

  return output;
}

module.exports = {
  serialize: serialize,
  deserialize: deserialize,
  deserializeField: deserializeField,
};
