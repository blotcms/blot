var client = require("models/client");
var key = require("models/template/key");
var updateCdnManifest = require("models/template/util/updateCdnManifest");

// Regenerates the CDN manifest of each template that rebuildDependents marked
// as pending during this sync, once each however many of its files changed.
// Resolves to the number of templates updated. log is passed in an options
// object. Errors for a template are logged and the rest carry on.
//
// A template leaves the pending set only once its manifest has been
// regenerated, so a process killed mid-way (a deploy) leaves it, and the
// rest, for the next sync. One whose regeneration fails stays pending too, so
// the next sync retries it rather than leaving its manifest stale. The set is
// read once, so a template that keeps failing is tried once per call.
module.exports = async function regenerateTemplateManifests(blogID, { log }) {
  var pendingKey = key.templateManifestsPending(blogID);
  var templateIDs = await client.sMembers(pendingKey);
  var count = 0;

  for (var templateID of templateIDs) {
    try {
      await updateCdnManifest(templateID);
    } catch (err) {
      log("Error updating CDN manifest for template", templateID, err.message);
      continue;
    }

    count++;

    try {
      await client.sRem(pendingKey, templateID);
    } catch (err) {
      // Regenerated again by the next sync, which is harmless
      log("Error clearing pending CDN manifest", templateID, err.message);
    }
  }

  return count;
};
