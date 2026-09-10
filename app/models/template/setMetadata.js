var key = require("./key");
var client = require("models/client");
var getMetadata = require("./getMetadata");
var serialize = require("./util/serialize");
var metadataModel = require("./metadataModel");
var ensure = require("helper/ensure");
var Blog = require("models/blog");
var injectLocals = require("./injectLocals");
var updateCdnManifest = require("./util/updateCdnManifest");
var serializeRedisHashValues = require("models/redisHashSerializer");

module.exports = function setMetadata(id, updates, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }

  options = options || {};

  try {
    ensure(id, "string").and(updates, "object").and(callback, "function");
  } catch (e) {
    return callback(e);
  }

  // When set, skip the owner-blog cacheID bump and CDN manifest rebuild that a
  // metadata change normally triggers. Bulk callers that touch many templates
  // use this to batch that work themselves. See setView's deferCacheBump.
  var deferCacheBump = options.deferCacheBump === true;

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

    var isPublic = metadata.isPublic === true || metadata.isPublic === "true";
    var owner = metadata.owner;

    metadata = serializeRedisHashValues(serialize(metadata, metadataModel));

    (async function () {
      try {
        if (isPublic) {
          await client.sAdd(key.publicTemplates(), id);
        } else {
          await client.sRem(key.publicTemplates(), id);
        }

        await client.sAdd(key.blogTemplates(owner), id);
        await client.hSet(key.metadata(id), metadata);

        // Caller batches cache invalidation and manifest rebuilds itself.
        if (deferCacheBump) return callback(null, changes);

        if (!changes) {
          return updateCdnManifest(id, function (manifestErr) {
            if (manifestErr) return callback(manifestErr);
            callback(null, changes);
          });
        }

        var shouldBumpCache = !(isPublic || owner === "SITE");
        var regenerateManifest = function () {
          updateCdnManifest(id, function (manifestErr) {
            if (manifestErr) return callback(manifestErr);
            callback(null, changes);
          });
        };

        if (!shouldBumpCache) return regenerateManifest();

        Blog.set(owner, { cacheID: Date.now() }, function (cacheErr) {
          if (cacheErr) return callback(cacheErr);
          regenerateManifest();
        });
      } catch (redisErr) {
        callback(redisErr);
      }
    })();
  });
};
