var getAllViews = require("./getAllViews");
var ensure = require("helper/ensure");
var client = require("models/client");
var key = require("./key");
var makeID = require("./util/makeID");
var Blog = require("models/blog");
var generateCdnUrl = require("./util/generateCdnUrl");
var purgeCdnUrls = require("helper/purgeCdnUrls");

module.exports = function drop(owner, templateName, callback) {
  var templateID = makeID(owner, templateName);
  var multi = client.multi();

  ensure(owner, "string").and(templateID, "string").and(callback, "function");

  getAllViews(templateID, function (err, views, metadata) {
    if (err && err.code !== "ENOENT") return callback(err);

    if (err && err.code === "ENOENT") {
      metadata = null;
      views = {};
    }

    views = views || {};

    var cdnManifest =
      metadata && metadata.cdn && typeof metadata.cdn === "object"
        ? metadata.cdn
        : {};
    var purgeUrls = [];

    for (var target in cdnManifest) {
      if (!Object.prototype.hasOwnProperty.call(cdnManifest, target)) continue;

      var hash = cdnManifest[target];
      if (typeof hash !== "string" || hash.length < 4) continue;

      try {
        purgeUrls.push(generateCdnUrl(target, hash));
      } catch (e) {
        console.error("Error generating CDN purge URL:", e);
      }

      multi.del(key.renderedOutput(hash));
    }

    multi.sRem(key.blogTemplates(owner), templateID);
    multi.del(key.metadata(templateID));
    multi.del(key.urlPatterns(templateID));
    multi.del(key.allViews(templateID));

    if (metadata && metadata.shareID) {
      multi.del(key.share(metadata.shareID));
    }

    for (var i in views) {
      multi.del(key.view(templateID, views[i].name));
      multi.del(key.url(templateID, views[i].url));
    }

    multi
      .exec()
      .then(function () {
        const ownerID = metadata && metadata.owner ? metadata.owner : owner;

        if (purgeUrls.length) {
          purgeCdnUrls(purgeUrls).catch(function (purgeErr) {
            console.error("Error purging CDN URLs while dropping template:", purgeErr);
          });
        }

        Blog.set(ownerID, { cacheID: Date.now() }, function (blogErr) {
          callback(blogErr, "Deleted " + templateID);
        });
      })
      .catch(callback);
  });
};
