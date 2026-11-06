var key = require("./key");
var client = require("models/client");
var withCallback = require("helper/withCallback");

module.exports = withCallback(async function isOwner(owner, id) {
  var isMember = await client.sIsMember(key.blogTemplates(owner), id);

  return !!isMember;
});
