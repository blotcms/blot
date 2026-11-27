var client = require("models/client");
var ensure = require("helper/ensure");
var key = require("./key");
var moment = require("moment");

// list(blogID, [options]) resolves to { list, ignored, totals }: the active
// and the ignored 404s, newest first, each { url, time }. With
// options.limit, list and ignored each hold at most that many, and only
// those are formatted (a relative time per row is the costly part); totals
// still counts every row, as { list, ignored }.
module.exports = async function (blogID, options) {
  ensure(blogID, "string");

  var limit = options && options.limit > 0 ? options.limit : Infinity;
  var everythingKey = key.everything(blogID);
  var ignoreKey = key.ignore(blogID);

  ensure(everythingKey, "string").and(ignoreKey, "string");

  var data = await Promise.all([
    client.sMembers(ignoreKey),
    client.zRangeWithScores(everythingKey, 0, -1, { REV: true }),
  ]);

  var ignoreThese = new Set(data[0]);
  var response = data[1];

  ensure(response, "array");

  var list = [];
  var ignored = [];
  var totals = { list: 0, ignored: 0 };

  response.forEach(function (entry) {
    var isIgnored = ignoreThese.has(entry.value);
    var bucket = isIgnored ? ignored : list;

    if (isIgnored) totals.ignored++;
    else totals.list++;

    if (bucket.length >= limit) return;

    bucket.push({
      url: entry.value,
      time: moment.utc(entry.score).fromNow(),
    });
  });

  return { list, ignored, totals };
};
