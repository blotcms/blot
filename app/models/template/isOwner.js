var key = require("./key");
var client = require("models/client");
var promiseOnly = require("helper/promiseOnly");

module.exports = promiseOnly(async function isOwner(owner, id) {
  var isMember = await client.sIsMember(key.blogTemplates(owner), id);

  return !!isMember;
});
