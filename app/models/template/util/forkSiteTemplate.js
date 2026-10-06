var { promisify } = require("util");
var makeSlug = require("helper/makeSlug");
var { MAX_DEDUPLICATION_ATTEMPTS } = require("../../../dashboard/site/template/save/constants");
var makeID = require('./makeID');
var getMetadataAsync = promisify(require('../getMetadata'));

function buildSlug(baseSlug, attempt) {
  if (attempt === 1) return baseSlug;

  var suffix = "-" + attempt;
  var trimmedBase = baseSlug.slice(0, 30 - suffix.length) || baseSlug;

  return makeSlug((trimmedBase + suffix).slice(0, 30));
}

// Forks a SITE-owned template into a blog's namespace, reusing an
// existing fork if one is already present. Returns the forked template ID
// or the original template ID if no forking was required.
module.exports = async function forkSiteTemplate(blogID, templateID) {

  // circular dependency so we import here
  var createAsync = promisify(require('../create'));

  if (!templateID || templateID.indexOf("SITE:") !== 0) return templateID;

  var siteTemplate = await getMetadataAsync(templateID);
  var baseName = siteTemplate.name;
  var baseSlug = siteTemplate.slug || makeSlug(siteTemplate.name).slice(0, 30);

  for (var attempt = 1; attempt <= MAX_DEDUPLICATION_ATTEMPTS; attempt++) {
    var suffix = attempt === 1 ? "" : " " + attempt;
    var deduplicatedName = baseName + suffix;
    var deduplicatedSlug = buildSlug(baseSlug, attempt);
    var forkID = makeID(blogID, deduplicatedName);

    try {
      var existingFork = await getMetadataAsync(forkID);
      if (existingFork) return forkID;
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }

    try {
      var forkMetadata = await createAsync(blogID, deduplicatedName, {
        name: deduplicatedName,
        slug: deduplicatedSlug,
        cloneFrom: templateID,
      });

      return forkMetadata.id;
    } catch (err) {
      if (err.code === "EEXISTS" && attempt < MAX_DEDUPLICATION_ATTEMPTS) {
        continue;
      }

      throw err;
    }
  }

  throw new Error("Unable to fork template after maximum attempts");
};
