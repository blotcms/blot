var redis = require("models/client");
var clfdate = require("helper/clfdate");
var entryKey = require("../entry/key").entry;

// A deleted entry keeps its key for this long (models/entry/set.js) so a
// file re-added at the same path - or a rename - can pick up its guid,
// created date and url. The key expires on its own, but its id stays in the
// "all" and "deleted" lists (models/entry/_assign.js), which Redis can't
// expire per member. Entry.set scores "deleted" with Date.now() in the same
// write that sets the TTL, so a "deleted" member scored more than this long
// ago is one whose key has expired - and that score is what this sweep uses
// to find and remove the dangling ids.
var DELETED_ENTRY_TTL_SECONDS = 24 * 60 * 60;

var BATCH_SIZE = 100;

async function sweep(blogID) {
  var allKey = "blog:" + blogID + ":all";
  var deletedKey = "blog:" + blogID + ":deleted";
  var cutoff = Date.now() - DELETED_ENTRY_TTL_SECONDS * 1000;
  var removed = [];
  // Ids skipped below stay at the front of the range, so step past
  // them rather than reading the same batch again.
  var offset = 0;

  while (true) {
    var ids = await redis.zRangeByScore(deletedKey, "-inf", cutoff, {
      LIMIT: { offset: offset, count: BATCH_SIZE },
    });

    if (!ids.length) break;

    var existsMulti = redis.multi();
    ids.forEach(function (id) {
      existsMulti.exists(entryKey(blogID, id));
    });
    var exists = await existsMulti.exec();

    // An old score with the key still present shouldn't happen (re-saving
    // a deleted entry re-scores it), but leave such ids alone.
    var batch = ids.filter(function (id, i) {
      return !exists[i];
    });

    // Not atomic with the EXISTS above: a file re-added at the same path in
    // between could lose its "all" membership. That needs a path dead for
    // over a day to come back within milliseconds, and the entry's next
    // save re-adds it to "all".
    if (batch.length) {
      await redis
        .multi()
        .zRem(allKey, batch)
        .zRem(deletedKey, batch)
        .exec();
    }

    removed = removed.concat(batch);
    offset += ids.length - batch.length;

    if (ids.length < BATCH_SIZE) break;
  }

  if (removed.length) {
    console.log(
      clfdate(),
      blogID.slice(0, 12),
      "swept",
      removed.length,
      "expired deleted entries"
    );
  }

  return removed;
}

module.exports = function sweepExpiredDeleted(blogID, callback) {
  sweep(blogID).then(function (removed) {
    callback(null, removed);
  }, callback);
};

module.exports.DELETED_ENTRY_TTL_SECONDS = DELETED_ENTRY_TTL_SECONDS;
