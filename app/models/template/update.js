var ensure = require("helper/ensure");
var makeID = require("./util/makeID");
var setMetadata = require("./setMetadata");

module.exports = function update(owner, name, metadata, callback) {
  ensure(owner, "string")
    .and(name, "string")
    .and(metadata, "object")
    .and(callback, "function");

  var id = makeID(owner, name);
  setMetadata(id, metadata, callback);
};
