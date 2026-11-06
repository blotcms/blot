var client = require("models/client");
var withCallback = require("helper/withCallback");
var key = require("./key");

module.exports = withCallback(async function getAllIds() {
  return await client.sMembers(key.uids);
});
