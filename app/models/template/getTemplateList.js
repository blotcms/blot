var client = require("models/client");
var key = require("./key");
var getMetadata = require("./getMetadata");
var ensure = require("helper/ensure");
var promiseOnly = require("helper/promiseOnly");

// The list of possible template choices
// for a given blog. Accepts a UID and
// returns an array of template metadata
// objects. Does not contain any view info
module.exports = promiseOnly(async function getTemplateList(blogID) {
  ensure(blogID, "string");

  var results = await Promise.all([
    client.sMembers(key.blogTemplates("SITE")),
    client.sMembers(key.blogTemplates(blogID)),
  ]);
  var siteTemplates = results[0] || [];
  var blogTemplates = results[1] || [];
  var templateIDs = siteTemplates.concat(blogTemplates);
  var response = [];

  // One template at a time, as before. A template whose metadata can't be
  // read is skipped, not an error.
  for (var id of templateIDs) {
    try {
      var info = await getMetadata(id);
      if (info) response.push(info);
    } catch (err) {
      // skipped
    }
  }

  return response;
});
