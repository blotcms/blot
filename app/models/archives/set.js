var client = require("models/client");
var ensure = require("helper/ensure");
var key = require("./key");
var bucket = require("./_bucket");

// Reconciles one entry's bucket membership, the months index, the entry's
// bucket marker, and the generation counter as a single atomic step.
//
// This used to be a `multi.exec()` (add/remove/marker/generation) followed
// by a *separate* round-trip `eval` to prune an emptied month from the
// months index. That gap between the two calls was a real bug: if the
// process crashed (or the eval call itself failed) in between, a month
// could be left in the months index with zero real members - a "ghost"
// month that renders an empty year/month header on /archives forever,
// since the sync fixer (app/sync/fix/archives-index.js) only compares
// *total* entry counts, which a zero-count ghost doesn't change. Doing
// everything in one Lua script closes that gap: either the whole
// reconciliation (including the prune) happens, or none of it does.
var reconcile = `
  local newBucketKey = KEYS[1]
  local monthsKey = KEYS[2]
  local entryKey = KEYS[3]
  local generationKey = KEYS[4]
  local oldBucketKey = KEYS[5]

  local entryID = ARGV[1]
  local isVisible = ARGV[2] == "1"
  local newBucket = ARGV[3]
  local dateScore = ARGV[4]
  local monthScore = ARGV[5]
  local oldBucket = ARGV[6]

  local bucketChanged = oldBucket ~= "" and oldBucket ~= newBucket

  if bucketChanged then
    redis.call('ZREM', oldBucketKey, entryID)
  end

  if isVisible then
    redis.call('ZADD', newBucketKey, dateScore, entryID)
    redis.call('ZADD', monthsKey, monthScore, newBucket)
    redis.call('SET', entryKey, newBucket)
  elseif oldBucket ~= "" then
    redis.call('DEL', entryKey)
  end

  redis.call('INCR', generationKey)

  if bucketChanged or (not isVisible and oldBucket ~= "") then
    if redis.call('ZCARD', oldBucketKey) == 0 then
      redis.call('ZREM', monthsKey, oldBucket)
    end
  end

  return 1
`;

// Keeps the precomputed year/month archives index for one entry in sync.
// Called alongside models/tags' set() from app/models/entry/set.js's save
// queue. Unlike tags (whose sorted-set key is the stable tag name), an
// archive bucket's key is derived from dateStamp, so a dateStamp edit that
// crosses a month boundary has to move the entry between two sorted sets -
// key.entry(blogID, entry.id) remembers which bucket an entry is currently
// in so we know what to remove it from.
module.exports = function (blogID, entry, timeZone, callback) {
  ensure(blogID, "string").and(timeZone, "string").and(callback, "function");

  var entryKey = key.entry(blogID, entry.id);

  // An entry with no valid dateStamp can't be bucketed by month at all -
  // rebuild() skips these entirely (see rebuild.js), so this has to agree,
  // or an incremental save and a full rebuild would disagree about where
  // (or whether) such an entry appears in the index.
  var isVisible = bucket.visible(entry) && bucket.hasDateStamp(entry);
  var newBucket = isVisible
    ? bucket.yearMonth(entry.dateStamp, timeZone)
    : null;

  (async function () {
    var oldBucket = await client.get(entryKey);

    // Lua needs a fixed key list. When there's no old bucket (first save)
    // or the entry isn't visible (no new bucket), these keys are never
    // dereferenced by the script's guarded branches - the placeholder
    // bucket name just has to be a valid key string.
    var newBucketKey = key.bucket(blogID, newBucket || oldBucket || "none");
    var oldBucketKey = key.bucket(blogID, oldBucket || newBucket || "none");

    await client.eval(reconcile, {
      keys: [
        newBucketKey,
        key.months(blogID),
        entryKey,
        key.generation(blogID),
        oldBucketKey,
      ],
      arguments: [
        entry.id,
        isVisible ? "1" : "0",
        newBucket || "",
        String(entry.dateStamp || 0),
        String(newBucket ? bucket.score(newBucket) : 0),
        oldBucket || "",
      ],
    });

    callback();
  })().catch(function (err) {
    callback(err);
  });
};
