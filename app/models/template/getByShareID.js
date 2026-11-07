var key = require("./key");
var client = require("models/client");
var getMetadata = require("./getMetadata");
var promiseOnly = require("helper/promiseOnly");

module.exports = promiseOnly(async function getByShareID(shareID) {
  var id = await client.get(key.share(shareID));

  if (!id) {
    throw new Error("No template with shareID: " + shareID);
  }

  return getMetadata(id);
});
