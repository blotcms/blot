var client = require("models/client");
var key = require("./key");
var promiseOnly = require("helper/promiseOnly");

module.exports = promiseOnly(async function getAllIDs() {
  return client.sMembers(key.ids);
});
