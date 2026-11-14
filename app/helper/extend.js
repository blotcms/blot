var type = require("./type");
var ensure = require("./ensure");

function extend(a) {
  if (a === undefined) a = {};

  return {
    and: function next(b) {
      softMerge(a, b);
      return extend(a);
    },
  };
}

// if property on a is set, use it,
// if not, use B's value
// Arrays are merged (union) when both exist
function softMerge(a, b) {
  ensure(a, "object").and(b, "object");

  for (var i in b) {
    // b can come from parsed JSON (template packages, form posts), where
    // these keys would let a merge write into Object.prototype
    if (i === "__proto__" || i === "constructor" || i === "prototype") continue;

    var aType = type(a[i]);
    var bType = type(b[i]);

    // Handle mixed types: if either is an array, normalize and merge
    if (aType === "array" || bType === "array") {
      // Normalize both to arrays
      var aArray = aType === "array" ? a[i] : [];
      var bArray = bType === "array" ? b[i] : [];

      // Merge arrays (union with deduplication)
      var combined = aArray.concat(bArray);

      a[i] = [...new Set(combined)];
      continue;
    }

    // If both are objects, recursively merge
    if (aType === "object" && bType === "object") {
      softMerge(a[i], b[i]);
      continue;
    }

    // Otherwise, soft merge (only set if undefined)
    if (a[i] === undefined) {
      a[i] = b[i];
    }
  }
}

module.exports = extend;
