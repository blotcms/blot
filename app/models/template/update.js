var ensure = require("helper/ensure");
var makeID = require("./util/makeID");
var setMetadata = require("./setMetadata");

module.exports = async function update(owner, name, metadata) {
  ensure(owner, "string").and(name, "string").and(metadata, "object");

  var id = makeID(owner, name);

  return setMetadata(id, metadata);
};
