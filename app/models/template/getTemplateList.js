var client = require("models/client");
var key = require("./key");
var getMetadata = require("./getMetadata");
var ensure = require("helper/ensure");

// The list of possible template choices
// for a given blog. Accepts a UID and
// returns an array of template metadata
// objects. Does not contain any view info
module.exports = async function getTemplateList(blogID) {
  ensure(blogID, "string");

  var results = await Promise.all([
    client.sMembers(key.blogTemplates("SITE")),
    client.sMembers(key.blogTemplates(blogID)),
  ]);
  var siteTemplates = results[0] || [];
  var blogTemplates = results[1] || [];
  var templateIDs = siteTemplates.concat(blogTemplates);

  // Every template's metadata is read at once rather than one after another,
  // keeping the order of the IDs. A template whose metadata can't be read is
  // skipped, not an error.
  var metadata = await Promise.all(
    templateIDs.map(function (id) {
      return getMetadata(id).catch(function () {
        return null;
      });
    })
  );

  return metadata.filter(Boolean);
};
