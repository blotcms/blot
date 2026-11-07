var client = require("models/client");
var ensure = require("helper/ensure");
var key = require("./key");
var moment = require("moment");

// Resolves to { list, ignored }: the active and the ignored 404s, most recent
// first, each { url, time }
module.exports = async function (blogID) {
  ensure(blogID, "string");

  var everythingKey = key.everything(blogID);
  var ignoreKey = key.ignore(blogID);

  ensure(everythingKey, "string").and(ignoreKey, "string");

  var data = await Promise.all([
    client.sMembers(ignoreKey),
    client.zRangeWithScores(everythingKey, 0, -1, { REV: true }),
  ]);

  var ignoreThese = data[0];
  var response = data[1];

  ensure(ignoreThese, "array").and(response, "array");

  var list = [];
  var ignored = [];

  for (var itemIndex in response) {
    var entry = response[itemIndex];

    var item = {
      url: entry.value,
      time: moment.utc(entry.score).fromNow(),
    };

    if (ignoreThese.indexOf(entry.value) > -1) {
      ignored.push(item);
    } else {
      list.push(item);
    }
  }

  return { list, ignored };
};
