var client = require("models/client");
var key = require("./key");

module.exports = async function getAllIDs() {
  return client.sMembers(key.ids);
};
