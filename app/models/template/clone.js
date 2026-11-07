var ensure = require("helper/ensure");
var extend = require("helper/extend");
var getAllViews = require("./getAllViews");
var setMultipleViews = require("./setMultipleViews");
var getMetadata = require("./getMetadata");
var setMetadata = require("./setMetadata");
var updateCdnManifest = require("./util/updateCdnManifest");
var cacheID = require("./util/cacheID");

module.exports = async function clone(fromID, toID, metadata) {
  ensure(fromID, "string").and(toID, "string").and(metadata, "object");

  var allViews;

  try {
    allViews = (await getAllViews(fromID)).views;
  } catch (err) {
    // handled below
  }

  if (!allViews) {
    var message = "No theme with that name exists to clone from " + fromID;
    throw new Error(message);
  }

  await setMultipleViews(toID, allViews);

  var existingMetadata;

  try {
    existingMetadata = await getMetadata(fromID);
  } catch {
    throw new Error("Could not clone from " + fromID);
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

  // Uploaded template images also live under the source blog's asset
  // directory. Preserve each declaration on a cross-owner clone, but
  // clear its value so the recipient cannot retain a URL whose files are
  // owned and eventually cleaned up by another blog.
  if (
    metadata.locals &&
    existingMetadata.owner &&
    metadata.owner !== existingMetadata.owner
  ) {
    Object.keys(metadata.locals).forEach(function (key) {
      var value = metadata.locals[key];
      if (key.endsWith("_image") && value && value.url) {
        metadata.locals[key] = {};
      }
    });
  }

  // Don't copy the CDN manifest - it will be regenerated with new hashes
  // based on the new template ID to ensure hashes reflect the new template
  // and files are stored on disk with the correct hash
  delete metadata.cdn;

  // Likewise the files the manifest depends on: the clone builds its own
  // reverse-index entries when its manifest is generated
  delete metadata.fileDependencies;

  await setMetadata(toID, metadata);

  // Regenerate CDN manifest with new template ID to ensure
  // hashes reflect the new template and files are stored on disk.
  // Its views and metadata were saved with new template cacheIDs, so
  // no cached full views are reused; the blog's own is bumped first
  // if it has the clone installed.
  await cacheID.bumpBlogIfInstalled(metadata.owner, toID);

  return updateCdnManifest(toID);
};
