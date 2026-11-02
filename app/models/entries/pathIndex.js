var ensure = require("helper/ensure");
var redis = require("models/client");

function entriesKey(blogID) {
  return "blog:" + blogID + ":entries";
}

function lexKey(blogID) {
  return "blog:" + blogID + ":entries:lex";
}

function backfillIndex(blogID, callback) {
  ensure(blogID, "string").and(callback, "function");

  (async function () {
    var ids = await redis.zRange(entriesKey(blogID), 0, -1);
    var multi = redis.multi();

    multi.del(lexKey(blogID));

    if (ids && ids.length) {
      for (var i = 0; i < ids.length; i++) {
        multi.zAdd(lexKey(blogID), { score: 0, value: ids[i] });
      }
    }

    await multi.exec();

    callback(null, ids ? ids.length : 0);
  })().catch(function (err) {
    callback(err);
  });
}

module.exports = {
  lexKey: lexKey,
  backfillIndex: backfillIndex,
};
