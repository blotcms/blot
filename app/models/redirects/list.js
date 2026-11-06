var client = require("models/client");
var ensure = require("helper/ensure");
var key = require("./key");
var _ = require("lodash");
var withCallback = require("helper/withCallback");

module.exports = withCallback(async function list(blogID) {
  ensure(blogID, "string");

  var redirects = key.redirects(blogID);

  var froms = await client.zRange(redirects, 0, -1);

  if (!froms.length) return [];

  var fromKeys = _.map(froms, function (from) {
    return key.redirect(blogID, from);
  });

  var tos = await client.mGet(fromKeys);

  if (tos.length !== froms.length) {
    throw new Error("Length mismatch");
  }

  var allRedirects = _.zip(froms, tos);

  var i = 0;

  return _.map(allRedirects, function (redir) {
    return {
      from: redir[0],
      to: redir[1],
      index: i++,
    };
  });
});
