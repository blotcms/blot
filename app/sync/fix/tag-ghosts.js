var Tags = require("models/tags");
var Entry = require("models/entry");
var async = require("async");
var client = require("models/client");
var entryKey = require("models/entry/key").entry;

function execTransaction(multi, callback) {
  var done = false;
  function onDone(err) {
    if (done) return;
    done = true;
    callback(err);
  }

  var result;
  try {
    result = multi.exec(onDone);
  } catch (err) {
    return onDone(err);
  }

  if (result && typeof result.then === "function") {
    Promise.resolve(result).then(
      function () {
        onDone();
      },
      onDone
    );
  }
}

// entryIDs can run into the thousands across a blog's tags, and the same
// entry is frequently a member of several tags - an entry with 8 tags used
// to be read from Redis in full 8 times in one run. This memoises only the
// small fields needed to detect a ghost (id) per entryID for the lifetime
// of a single tag-ghosts call, and fetches unresolved ids in batched MGETs
// (preserving index alignment, unlike Entry.get which filters out missing
// entries) rather than one GET per id. Only hits are memoised: a miss is
// re-read for each tag, so an entry a concurrent sync restores mid-run isn't
// pruned from later tags. Each MGET reply holds whole entries and shares a
// connection with the lock heartbeat, so a batch is kept to the 20 full
// reads the previous version had in flight at once.
var BATCH_SIZE = 20;

function resolveEntryIDs(blogID, entryIDs, resolved, callback) {
  var unresolved = entryIDs.filter(function (id) {
    return !resolved.has(id);
  });

  var batches = [];
  for (var i = 0; i < unresolved.length; i += BATCH_SIZE) {
    batches.push(unresolved.slice(i, i + BATCH_SIZE));
  }

  async.eachSeries(
    batches,
    function (batch, next) {
      var keys = batch.map(function (id) {
        return entryKey(blogID, id);
      });

      client
        .mGet(keys)
        .then(function (values) {
          (values || []).forEach(function (value, index) {
            var id = batch[index];

            if (!value) return;

            try {
              resolved.set(id, { id: JSON.parse(value).id });
            } catch (e) {
              // Unparseable - treated as missing, like a nil reply.
            }
          });

          // Yield so V8 can reclaim this batch's parsed JSON before the
          // next batch is fetched.
          setImmediate(next);
        })
        .catch(next);
    },
    callback
  );
}

module.exports = function main(blog, callback) {
  const report = [];
  // id -> {id} for entries found, shared across every tag in this call.
  const resolved = new Map();
  // Stale ids whose full repair (rename + Entry.set) has already run this
  // call - see the mismatch branch below.
  const repaired = new Set();

  Tags.list(blog.id, function (err, tags) {
    if (err) return callback(err);

    async.eachSeries(
      tags,
      function (tag, next) {
        Tags.get(blog.id, tag.slug, function (err, entryIDs) {
          if (err) return next(err);

          const tagKey = Tags.key.sortedTag(blog.id, tag.slug);

          if (!entryIDs.length) {
            report.push(["EMPTY TAG", tag]);
            const multi = client.multi();
            multi.sRem(Tags.key.all(blog.id), tag.slug);
            multi.del(tagKey);
            return execTransaction(multi, next);
          }

          resolveEntryIDs(blog.id, entryIDs, resolved, function (err) {
            if (err) return next(err);

            async.eachLimit(
              entryIDs,
              20,
              function (entryID, next) {
                const meta = resolved.get(entryID);

                if (!meta) {
                  report.push(["MISSING", entryID]);
                  const multi = client.multi();
                  multi.zRem(tagKey, entryID);
                  return execTransaction(multi, next);
                }

                if (meta.id === entryID) return next();

                if (repaired.has(entryID)) {
                  // Already fully repaired via an earlier tag this run -
                  // Entry.set's Tags.set call (triggered by that repair)
                  // already re-added the real id to every tag in
                  // entry.tags, including this one if it's still tagged
                  // here. The reverse key (Tags.key.entry) was already
                  // renamed away as part of that repair, so renaming it
                  // again would fail with "no such key" - just drop the
                  // stale id from this tag instead.
                  report.push(["MISMATCH", entryID, meta.id]);
                  const multi = client.multi();
                  multi.zRem(tagKey, entryID);
                  return execTransaction(multi, next);
                }

                // Rare - re-fetch the full entry (content included) only
                // for this mismatched id, so it can be re-saved as-is
                // under the correct key.
                Entry.get(blog.id, entryID, function (entry) {
                  if (!entry) {
                    resolved.delete(entryID);
                    report.push(["MISSING", entryID]);
                    const multi = client.multi();
                    multi.zRem(tagKey, entryID);
                    return execTransaction(multi, next);
                  }

                  report.push(["MISMATCH", entryID, entry.id]);
                  var multi = client.multi();
                  var entryKeyForIncorrectID = Tags.key.entry(blog.id, entryID);
                  var entryKeyForCorrectID = Tags.key.entry(blog.id, entry.id);
                  var score = entry.dateStamp;
                  if (typeof score !== "number" || isNaN(score)) {
                    score = Date.now();
                  }

                  multi.rename(entryKeyForIncorrectID, entryKeyForCorrectID);
                  multi.zRem(tagKey, entryID);
                  multi.zAdd(tagKey, { score: score, value: entry.id });
                  execTransaction(multi, function (err) {
                    if (err) return next(err);
                    Entry.set(blog.id, entry.id, entry, function (err) {
                      if (err) return next(err);
                      // Leave entryID resolved as a mismatch, and remember
                      // it's been fully repaired, so another tag holding
                      // the same stale id just drops it instead of
                      // repeating the now-impossible rename.
                      resolved.set(entry.id, { id: entry.id });
                      repaired.add(entryID);
                      next();
                    });
                  });
                });
              },
              next
            );
          });
        });
      },
      function (err) {
        if (err) return callback(err);
        callback(null, report);
      }
    );
  });
};
