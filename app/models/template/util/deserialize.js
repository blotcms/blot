var _ = require("lodash");
var ensure = require("helper/ensure");

module.exports = function deserialize(sourceObj, model) {
  // We don't want to modify the
  // obj passed in case we use it
  // elsewhere in future
  var obj = _.cloneDeep(sourceObj);

  for (var i in obj) {
    if (model[i] === "object" || model[i] === "array")
      obj[i] = JSON.parse(obj[i]);

    if (model[i] === "boolean") obj[i] = obj[i] === "true";
  }

  // ensure(obj, model);

  return obj;
};
