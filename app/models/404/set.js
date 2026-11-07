var client = require("models/client");
var ensure = require("helper/ensure");
var Key = require("./key");

var MAX_404s = 500;

module.exports = async function (blogID, url) {
  ensure(blogID, "string").and(url, "string");

  var key = Key.everything(blogID);
  var now = Date.now();
  var thirtyDaysAgo = now - 1000 * 60 * 60 * 24 * 30;

  var multi = client.multi();

  // Add the new 404
  multi.zAdd(key, {
    score: now,
    value: url,
  });

  // Remove any entries which are older than 30 days
  // -inf is to avoid looking up the lowest score in the sorted set.
  multi.zRemRangeByScore(key, "-inf", thirtyDaysAgo);

  // Trim the list of 404s
  multi.zRemRangeByRank(key, 0, -MAX_404s);

  await multi.exec();
};
