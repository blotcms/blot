var client = require("models/client");
var key = require("models/template/key");
var updateCdnManifest = require("models/template/util/updateCdnManifest");

// Regenerates the CDN manifest of each template that rebuildDependents marked
// as pending during this sync, once each however many of its files changed.
// Callback receives (err, count) where count is the number of templates
// updated. Errors for a template are logged and the rest carry on.
//
// Templates are popped one at a time, so a crash mid-way leaves the rest
// pending for the next sync (and loses at most the one in flight).
module.exports = function regenerateTemplateManifests(blogID, log, callback) {
  (async function () {
    var count = 0;
    var templateID;

    while ((templateID = await client.sPop(key.templateManifestsPending(blogID)))) {
      try {
        await new Promise(function (resolve, reject) {
          updateCdnManifest(templateID, function (err) {
            if (err) return reject(err);
            resolve();
          });
        });

        count++;
      } catch (err) {
        log("Error updating CDN manifest for template", templateID, err.message);
      }
    }

    return count;
  })().then(
    function (count) {
      callback(null, count);
    },
    function (err) {
      callback(err);
    }
  );
};
