var Tags = require("models/tags");
var Entry = require("models/entry");
var async = require("async");
var client = require("models/client");
var createEntryCache = require("./entry-cache");

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

module.exports = function main(blog, cache, callback) {
  if (typeof cache === "function") {
    callback = cache;
    cache = createEntryCache(blog.id);
  }

  const report = [];
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

          // Every entryID this tag references is resolved through the
          // shared cache, so an entry that appears in several tags (or was
          // already read by an earlier check this Fix() run) is fetched
          // from Redis at most once total, not once per tag it's in.
          cache.getMany(entryIDs, function (err, resolved) {
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

                // Rare - re-fetch the full entry (content included) only
                // for this mismatched id, so it can be re-saved as-is
                // under the correct key.
                Entry.get(blog.id, entryID, function (entry) {
                  if (!entry) {
                    // Vanished between the cached read and now - treat as
                    // MISSING rather than act on stale cached data.
                    cache.invalidate(entryID);
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
                      cache.invalidate(entryID);
                      cache.invalidate(entry.id);
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
