// An entry as models/entry hands it out. It has no methods: the prototype
// only marks entries for instanceof (render/load/eachEntry finds the entries
// in a view's locals that way).
//
// Built from init in one go rather than a key at a time (#2795): past ~16
// keys, adding properties one by one leaves an object in V8's dictionary
// mode, ~1,700 bytes for an entry's ~30 fields instead of ~300. Returning
// the literal from the constructor keeps `new Entry(init) instanceof Entry`.
module.exports = function Entry(init) {
  if (
    init &&
    typeof init === "object" &&
    !Object.getOwnPropertySymbols(init).length
  )
    return { __proto__: Entry.prototype, ...init };
  for (var i in init) this[i] = init[i];
};
