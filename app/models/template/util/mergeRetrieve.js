var extend = require("helper/extend");
var type = require("helper/type");

// Where one side of the merge has a bare `true` and the other a structured
// value, promote the boolean to `{}` so `extend` deep-merges the object into
// it rather than letting the boolean overwrite it (e.g. plugin: true  +
// plugin: { katex: { css: true } } keeps the katex leaf).
function reconcileBooleans(target, source) {
  Object.keys(source).forEach(function (key) {
    var targetVal = target[key];
    var sourceVal = source[key];

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
