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

// Removes each id from "all" and "deleted" only if it is still scored
// before the cutoff in "deleted" and its entry key is gone. Both are
// re-checked inside the script, so a file re-added at the same path between
// the ZRANGEBYSCORE below and this call is left alone.
//
// KEYS[1] = all, KEYS[2] = deleted, KEYS[2 + i] = entry key for ARGV[1 + i]
// ARGV[1] = cutoff, ARGV[1 + i] = id
var REMOVE_EXPIRED = `
local removed = {}
for i = 2, #ARGV do
  local score = redis.call('ZSCORE', KEYS[2], ARGV[i])
  if score and tonumber(score) <= tonumber(ARGV[1]) and redis.call('EXISTS', KEYS[i + 1]) == 0 then
    redis.call('ZREM', KEYS[1], ARGV[i])
    redis.call('ZREM', KEYS[2], ARGV[i])
    table.insert(removed, ARGV[i])
  end
end
return removed
`;

async function sweep(blogID) {
  var allKey = "blog:" + blogID + ":all";
  var deletedKey = "blog:" + blogID + ":deleted";
  var cutoff = Date.now() - DELETED_ENTRY_TTL_SECONDS * 1000;
  var removed = [];
  // Ids the script skipped stay at the front of the range, so step past
  // them rather than reading the same batch again.
  var offset = 0;

  while (true) {
    var ids = await redis.zRangeByScore(deletedKey, "-inf", cutoff, {
      LIMIT: { offset: offset, count: BATCH_SIZE },
    });

    if (!ids.length) break;

    var batch = await redis.eval(REMOVE_EXPIRED, {
      keys: [allKey, deletedKey].concat(
        ids.map(function (id) {
          return entryKey(blogID, id);
        })
      ),
      arguments: [String(cutoff)].concat(ids),
    });

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
