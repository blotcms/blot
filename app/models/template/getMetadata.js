var key = require("./key");
var client = require("models/client");
var deserialize = require("./util/deserialize");
var metadataModel = require("./metadataModel");

module.exports = async function getMetadata(id) {
  var metadata = await client.hGetAll(key.metadata(id));
  var rawHasFields = metadata && Object.keys(metadata).length > 0;

  if (!rawHasFields) {
    const err = new Error("No template: " + id);
    err.code = "ENOENT";
    throw err;
  }

  metadata = deserialize(metadata, metadataModel);

  var metadataHasFields = metadata && Object.keys(metadata).length > 0;

  if (!metadataHasFields) {
    const err = new Error("No template: " + id);
    err.code = "ENOENT";
    throw err;
  }

  metadata.cdn = metadata.cdn || {};

  return metadata;
};
