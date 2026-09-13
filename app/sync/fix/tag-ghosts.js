var Tags = require("models/tags");
var Entry = require("models/entry");
var async = require("async");
var client = require("models/client");

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

module.exports = function main(blog, callback) {
  const report = [];
  Tags.list(blog.id, function (err, tags) {
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

          // entryIDs can run into the thousands for a popular tag, and each
          // fetch reads the entry in full (content included) - async.each
          // would fire all of those concurrently and hold them all in
          // memory at once, so cap how many are in flight together.
          async.eachLimit(
            entryIDs,
            20,
            function (entryID, next) {
              Entry.get(blog.id, entryID, function (entry) {
                if (!entry) {
                  report.push(["MISSING", entryID]);
                  const multi = client.multi();
                  multi.zRem(tagKey, entryID);
                  return execTransaction(multi, next);
                }

                if (entry.id === entryID) return next();

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
                  Entry.set(blog.id, entry.id, entry, next);
                });
              });
            },
            next
          );
        });
      },
      function (err) {
        if (err) return callback(err);
        callback(null, report);
      }
    );
  });
};
