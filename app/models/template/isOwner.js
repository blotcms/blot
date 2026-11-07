var key = require("./key");
var client = require("models/client");

module.exports = async function isOwner(owner, id) {
  var isMember = await client.sIsMember(key.blogTemplates(owner), id);

  return !!isMember;
};
