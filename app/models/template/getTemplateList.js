var client = require("models/client");
var key = require("./key");
var getMetadata = require("./getMetadata");
var ensure = require("helper/ensure");

// The list of possible template choices
// for a given blog. Accepts a UID and
// returns an array of template metadata
// objects. Does not contain any view info
module.exports = function getTemplateList(blogID, callback) {
  ensure(blogID, "string").and(callback, "function");

  Promise.all([
    client.sMembers(key.blogTemplates("SITE")),
    client.sMembers(key.blogTemplates(blogID)),
  ])
    .then(function (results) {
      var siteTemplates = results[0] || [];
      var blogTemplates = results[1] || [];
      var templateIDs = siteTemplates.concat(blogTemplates);

      // Read every template's metadata at once rather than one after another;
      // keep the order of the IDs and skip templates that failed to load
      return Promise.all(
        templateIDs.map(function (id) {
          return new Promise(function (resolve) {
            getMetadata(id, function (err, info) {
              resolve(!err && info ? info : null);
            });
          });
        })
      );
    })
    // One handler pair, so an error thrown by the callback can't call it twice
    .then(function (metadata) {
      callback(null, metadata.filter(Boolean));
    }, callback);
};
