var key = require("./key");
var client = require("models/client");
var deserialize = require("./util/deserialize");
var metadataModel = require("./metadataModel");

module.exports = function getMetadata(id, callback) {
  client
    .hGetAll(key.metadata(id))
    .then(function (metadata) {
      var rawHasFields = metadata && Object.keys(metadata).length > 0;

      if (!rawHasFields) {
        const err = new Error("No template: " + id);
        err.code = "ENOENT";
        return callback(err, null);
      }

      metadata = deserialize(metadata, metadataModel);

      var metadataHasFields = metadata && Object.keys(metadata).length > 0;

      if (!metadataHasFields) {
        const err = new Error("No template: " + id);
        err.code = "ENOENT";
        return callback(err, null);
      }

      metadata.cdn = metadata.cdn || {};

      callback(null, metadata);
    })
    .catch(callback);
};
