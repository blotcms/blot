var client = require("models/client");
var promiseOnly = require("helper/promiseOnly");
var key = require("./key");

module.exports = promiseOnly(async function getAllIds() {
  return await client.sMembers(key.uids);
});
