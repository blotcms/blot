var key = require("./key");
var client = require("models/client");
var getByShareID = require("./getByShareID");
var setMetadata = require("./setMetadata");
var withCallback = require("helper/withCallback");

module.exports = withCallback(async function dropShareID(shareID) {
  var template = await getByShareID(shareID);

  template.shareID = "";
  await setMetadata(template.id, template);
  await client.del(key.share(shareID));
});
