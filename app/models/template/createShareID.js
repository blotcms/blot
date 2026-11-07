var key = require("./key");
var client = require("models/client");
var getMetadata = require("./getMetadata");
var setMetadata = require("./setMetadata");
var { v4: uuid } = require("uuid");

module.exports = async function createShareID(templateID) {
  var template = await getMetadata(templateID);

  template.shareID = uuid();
  await setMetadata(templateID, template);
  await client.set(key.share(template.shareID), templateID);

  return template.shareID;
};
