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
      multi.del(key.renderedOutputName(hash));
    }

    // The template no longer depends on any files in its blog's folder
    // (see util/updateCdnManifest)
    var fileDependencies =
      metadata && Array.isArray(metadata.fileDependencies)
        ? metadata.fileDependencies
        : [];
    var dependencyOwner = metadata && metadata.owner ? metadata.owner : owner;

    fileDependencies.forEach(function (file) {
      multi.sRem(key.templateDependents(dependencyOwner, file), templateID);
    });

    // Nor should a sync regenerate its manifest (see
    // sync/update/regenerateTemplateManifests, which retries failures)
    multi.sRem(key.templateManifestsPending(dependencyOwner), templateID);

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
