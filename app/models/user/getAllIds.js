var client = require("models/client");
var key = require("./key");

module.exports = async function getAllIds() {
  return await client.sMembers(key.uids);
};
