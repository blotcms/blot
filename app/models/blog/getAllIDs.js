var client = require("models/client");
var key = require("./key");
var withCallback = require("helper/withCallback");

module.exports = withCallback(async function getAllIDs() {
  return client.sMembers(key.ids);
});
