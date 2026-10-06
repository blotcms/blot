var _ = require("lodash");
var ensure = require("helper/ensure");

module.exports = function deserialize(sourceObj, model) {
  // We don't want to modify the
  // obj passed in case we use it
  // elsewhere in future
  var obj = _.cloneDeep(sourceObj);

  for (var i in obj) {
    // isPublic was removed from metadata. Old hashes still have it because
    // HSET never deletes fields. Drop only that key: this helper also loads
    // views, and getFullView still reads leftover `type` (gone from viewModel
    // since 2019) to choose a Content-Type for extensionless names like "style".
    if (i === "isPublic" && !Object.prototype.hasOwnProperty.call(model, i)) {
      delete obj[i];
      continue;
    }

    if (model[i] === "object" || model[i] === "array")
      obj[i] = JSON.parse(obj[i]);

    if (model[i] === "boolean") obj[i] = obj[i] === "true";
  }

  // ensure(obj, model);

  return obj;
};
