var key = require("./key");
var client = require("models/client");
var getByShareID = require("./getByShareID");
var setMetadata = require("./setMetadata");
var promiseOnly = require("helper/promiseOnly");

module.exports = promiseOnly(async function dropShareID(shareID) {
  var template = await getByShareID(shareID);

  template.shareID = "";
  await setMetadata(template.id, template);
  await client.del(key.share(shareID));
});
