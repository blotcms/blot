var ensure = require("helper/ensure");
var redis = require("models/client");
var promiseOnly = require("helper/promiseOnly");

function entriesKey(blogID) {
  return "blog:" + blogID + ":entries";
}

function lexKey(blogID) {
  return "blog:" + blogID + ":entries:lex";
}

// async backfillIndex(blogID) rebuilds the lex index from the entries list and
// resolves how many ids it holds.
var backfillIndex = promiseOnly(async function backfillIndex(blogID) {
  ensure(blogID, "string");

  var ids = await redis.zRange(entriesKey(blogID), 0, -1);
  var multi = redis.multi();

  multi.del(lexKey(blogID));

  if (ids && ids.length) {
    for (var i = 0; i < ids.length; i++) {
      multi.zAdd(lexKey(blogID), { score: 0, value: ids[i] });
    }
  }

  await multi.exec();

  return ids ? ids.length : 0;
});

module.exports = {
  lexKey: lexKey,
  backfillIndex: backfillIndex,
};
