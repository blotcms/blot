var key = require("./key");
var client = require("models/client");
var getMetadata = require("./getMetadata");
var serialize = require("./util/serialize");
var metadataModel = require("./metadataModel");
var ensure = require("helper/ensure");
var injectLocals = require("./injectLocals");
var updateCdnManifest = require("./util/updateCdnManifest");
var cacheID = require("./util/cacheID");
var serializeRedisHashValues = require("models/redisHashSerializer");

module.exports = function setMetadata(id, updates, callback) {
  try {
    ensure(id, "string").and(updates, "object").and(callback, "function");
  } catch (e) {
    return callback(e);
  }

  getMetadata(id, function (err, metadata) {
    if (err && err.code !== "ENOENT") return callback(err);

    var changes;
    metadata = metadata || {};

    for (var i in updates) {
      if (metadata[i] !== updates[i]) changes = true;
      metadata[i] = updates[i];
    }

    metadata.cdn = metadata.cdn || {};

    if (!metadata.owner)
      return callback(new Error("No owner: please specify an owner for this template"));

    try {
      injectLocals(metadata.locals);
    } catch (e) {
      console.log("error injecting locals:", e);
    }

    var owner = metadata.owner;

    // Never write back the cacheID read above: a setView between that read
    // and this write may have replaced it, and restoring the old one would
    // let renders reuse views cached before that save (see util/cacheID).
    delete metadata.cacheID;
    if (changes) metadata.cacheID = cacheID.create();

    metadata = serializeRedisHashValues(serialize(metadata, metadataModel));

    (async function () {
      try {
        await client.sAdd(key.blogTemplates(owner), id);
        await client.hSet(key.metadata(id), metadata);

        if (!changes) {
          return updateCdnManifest(id, function (manifestErr) {
            if (manifestErr) return callback(manifestErr);
            callback(null, changes);
          });
        }

        cacheID.bumpBlogIfInstalled(owner, id, function (cacheErr) {
          if (cacheErr) return callback(cacheErr);
          updateCdnManifest(id, function (manifestErr) {
            if (manifestErr) return callback(manifestErr);
            callback(null, changes);
          });
        });
      } catch (redisErr) {
        callback(redisErr);
      }
    })();
  });
};
