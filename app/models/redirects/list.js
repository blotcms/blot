var client = require("models/client");
var ensure = require("helper/ensure");
var key = require("./key");
var _ = require("lodash");

module.exports = function (blogID, callback) {
  ensure(blogID, "string").and(callback, "function");

  var redirects = key.redirects(blogID);

  (async function () {
    try {
      var froms = await client.zRange(redirects, 0, -1);

      if (!froms.length) return callback(null, []);

      var fromKeys = _.map(froms, function (from) {
        return key.redirect(blogID, from);
      });

      var tos = await client.mGet(fromKeys);

      if (tos.length !== froms.length) {
        throw new Error("Length mismatch");
      }

      var allRedirects = _.zip(froms, tos);

      var i = 0;

      allRedirects = _.map(allRedirects, function (redir) {
        return {
          from: redir[0],
          to: redir[1],
          index: i++,
        };
      });

      callback(null, allRedirects);
    } catch (err) {
      return callback(err);
    }
  })();
};
