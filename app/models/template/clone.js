var ensure = require("helper/ensure");
var extend = require("helper/extend");
var getAllViews = require("./getAllViews");
var setMultipleViews = require("./setMultipleViews");
var getMetadata = require("./getMetadata");
var setMetadata = require("./setMetadata");
var updateCdnManifest = require("./util/updateCdnManifest");
var Blog = require("models/blog");

module.exports = function clone(fromID, toID, metadata, callback) {
  ensure(fromID, "string")
    .and(toID, "string")
    .and(metadata, "object")
    .and(callback, "function");

  getAllViews(fromID, function (err, allViews) {
    if (err || !allViews) {
      var message = "No theme with that name exists to clone from " + fromID;
      return callback(new Error(message));
    }

    setMultipleViews(toID, allViews, function (err) {
      if (err) return callback(err);

      getMetadata(fromID, function (err, existingMetadata) {
        if (err) {
          var message = "Could not clone from " + fromID;
          return callback(new Error(message));
        }

        // Copy across any metadata from the
        // source of the clone, if its not set
        extend(metadata).and(existingMetadata);

        // A favicon's generated files live under the source blog's asset
        // directory. Cloning into a different blog would leave the copy
        // referencing files it neither owns nor can clean up, so drop the
        // favicon local and let the new owner upload their own. Same-blog
        // duplicates keep it (upload-favicon guards shared prefixes).
        if (
          metadata.locals &&
          metadata.locals.favicon &&
          existingMetadata.owner &&
          metadata.owner !== existingMetadata.owner
        ) {
          delete metadata.locals.favicon;
        }

        // Don't copy the CDN manifest - it will be regenerated with new hashes
        // based on the new template ID to ensure hashes reflect the new template
        // and files are stored on disk with the correct hash
        delete metadata.cdn;

        setMetadata(toID, metadata, function (err) {
          if (err) return callback(err);

          // Regenerate CDN manifest with new template ID to ensure
          // hashes reflect the new template and files are stored on disk.
          // Bump blog cache first so any cached full views are not reused.
          var regenerateManifest = function () {
            updateCdnManifest(toID, callback);
          };

          if (!metadata.owner || metadata.owner === "SITE" || metadata.isPublic) {
            return regenerateManifest();
          }

          Blog.set(metadata.owner, { cacheID: Date.now() }, function (cacheErr) {
            if (cacheErr) return callback(cacheErr);
            regenerateManifest();
          });
        });
      });
    });
  });
};
