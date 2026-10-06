var client = require("models/client");
var key = require("./key");
var async = require("async");
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
      var response = [];

      async.eachSeries(
        templateIDs,
        function (id, next) {
          getMetadata(id, function (err, info) {
            if (!err && info) response.push(info);
            next();
          });
        },
        function () {
          callback(null, response);
        }
      );
    })
    .catch(callback);
};
