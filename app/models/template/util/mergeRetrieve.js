var extend = require("helper/extend");
var type = require("helper/type");

// Only field-projection metadata - an object carrying a `fields` map, e.g.
// { fields: { title: true } } - treats a boolean as "field set unknown".
function isProjectionMetadata(value) {
  return type(value, "object") && type(value.fields, "object");
}

// A boolean projection value (e.g. allEntries: true) means "this local is used
// but we don't know which fields" - it has to win over a recalculated
// { fields: { ... } } from the other side of a merge, otherwise the merged
// metadata becomes a restrictive whitelist and projection can delete a field
// the boolean side actually renders. This happens whenever a view and one of
// its partials are saved / recalculated independently.
//
// This rule is scoped to projection metadata. Every other structured retrieve
// value (plugin.katex.css, nested asset trees, ...) keeps the pre-existing
// behaviour: promote a boolean so a later object merges into it.
function reconcileBooleans(target, source) {
  Object.keys(source).forEach(function (key) {
    var targetVal = target[key];
    var sourceVal = source[key];

    if (sourceVal === true && isProjectionMetadata(targetVal)) {
      target[key] = true;
      return;
    }

    if (targetVal === true && isProjectionMetadata(sourceVal)) {
      target[key] = true;
      return;
    }

    // Non-projection: let a boolean become an object so `extend` can fill it in
    // (e.g. plugin: true  +  plugin: { katex: { css: true } }).
    if (targetVal === true && type(sourceVal, "object")) {
      target[key] = {};
      targetVal = target[key];
    }

    if (type(targetVal, "object") && type(sourceVal, "object")) {
      reconcileBooleans(targetVal, sourceVal);
    }
  });
}

module.exports = function mergeRetrieve(target, source) {
  target = target || {};
  source = source || {};
  reconcileBooleans(target, source);
  extend(target).and(source);
  return target;
};
