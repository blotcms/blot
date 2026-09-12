var client = require("models/client");
var ensure = require("helper/ensure");
var key = require("./key");

// Every "YYYY-MM" bucket with at least one entry, newest first, with counts.
// One ZRANGE for the month list plus one ZCARD per month, all in parallel -
// O(months), never O(entries). Mirrors models/tags/list.js's GET+ZCARD fan-out.
module.exports.months = async function (blogID) {
  ensure(blogID, "string");

  var yearMonths = await client.zRange(key.months(blogID), 0, -1, {
    REV: true,
  });

  if (!yearMonths.length) return [];

  var counts = await Promise.all(
    yearMonths.map(function (yearMonth) {
      return client.zCard(key.bucket(blogID, yearMonth));
    })
  );

  return yearMonths.map(function (yearMonth, i) {
    return { yearMonth: yearMonth, count: counts[i] || 0 };
  });
};

// entryIDs published in {yearMonth}, newest first.
module.exports.bucket = async function (blogID, yearMonth) {
  ensure(blogID, "string").and(yearMonth, "string");

  return client.zRange(key.bucket(blogID, yearMonth), 0, -1, { REV: true });
};

module.exports.isReady = async function (blogID) {
  ensure(blogID, "string");

  return Boolean(await client.get(key.ready(blogID)));
};
