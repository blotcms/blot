var getAllViews = require("./getAllViews");
var ensure = require("helper/ensure");
var client = require("models/client");
var key = require("./key");
var makeID = require("./util/makeID");
var Blog = require("models/blog");
var path = require("path");
var fs = require("fs-extra");
var config = require("config");
var generateCdnUrl = require("./util/generateCdnUrl");
var purgeCdnUrls = require("helper/purgeCdnUrls");

var renderedOutputBaseDir = path.join(config.data_directory, "cdn", "template");

function getRenderedOutputPath(hash, target) {
  var basename = path.basename(target);
  var dir1 = hash.substring(0, 2);
  var dir2 = hash.substring(2, 4);
  var hashRemainder = hash.substring(4);

  return path.join(renderedOutputBaseDir, dir1, dir2, hashRemainder, basename);
}

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
    var diskCleanup = [];

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

      diskCleanup.push(
        fs.remove(getRenderedOutputPath(hash, target)).catch(function (removeErr) {
          if (removeErr.code !== "ENOENT") {
            console.error("Error removing CDN rendered output from disk:", removeErr);
          }
        })
      );
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

    Promise.allSettled(diskCleanup)
      .then(function () {
        return multi.exec();
      })
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
