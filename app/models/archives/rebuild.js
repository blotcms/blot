var client = require("models/client");
var createRedisClient = require("../redis");
var WatchError = require("redis").WatchError;
var ensure = require("helper/ensure");
var key = require("./key");
var bucket = require("./_bucket");

var MAX_ATTEMPTS = 5;

// Rebuilds the archives index for a blog from scratch, from the canonical
// "entries" sorted set (already exactly the published/visible posts
// archives should show - see models/entries/index.js's getAll). Mirrors
// models/entries/pathIndex.js's backfillIndex: cheap to call repeatedly,
// safe to call on a blog with no entries, sets a "ready" flag when done.
//
// Blog and Entries are required lazily (inside the function, not at module
// scope) because both eventually require models/blog/set.js, which requires
// this module's index (to trigger a rebuild on timezone change) - a
// module-scope require here would deadlock on that cycle.
module.exports = function rebuild(blogID, callback) {
  ensure(blogID, "string").and(callback, "function");

  var Blog = require("../blog");
  var Entries = require("../entries");

  (async function () {
    var blog = await new Promise(function (resolve, reject) {
      Blog.get({ id: blogID }, function (err, blog) {
        if (err) return reject(err);
        if (!blog) return reject(new Error("Blog not found: " + blogID));
        resolve(blog);
      });
    });

    // Clear the ready flag up front, before any work that could fail or
    // race. If this rebuild aborts (see below) or crashes partway, "ready"
    // is left false rather than stale-true - the sync fixer (which checks
    // isReady before comparing counts) and archives.js's own lazy-rebuild
    // path both then retry it later, instead of trusting an index that may
    // never have finished (or, for a timezone change, is still bucketed by
    // the old timezone even though the entry counts still match).
    await client.del(key.ready(blogID));

    // WATCH needs its own connection: models/client is a single shared
    // connection used by the whole process, and WATCH/MULTI/EXEC state is
    // per-connection, not per logical caller - sharing it here would let an
    // unrelated concurrent transaction elsewhere clear our watch (or ours
    // clear theirs) before either side calls EXEC.
    var isolated = createRedisClient();
    await isolated.connect();

    try {
      var entryCount = await attempt(MAX_ATTEMPTS);
      callback(null, entryCount);
    } catch (err) {
      callback(err);
    } finally {
      isolated.destroy();
    }

    async function attempt(attemptsLeft) {
      // set() bumps this on every entry save (see models/archives/set.js).
      // If one lands between our snapshot below and exec(), the watch trips
      // and we retry from a fresh snapshot instead of overwriting a newer
      // write with stale data.
      await isolated.watch(key.generation(blogID));

      var entries = await new Promise(function (resolve, reject) {
        Entries.getAll(blogID, { fields: ["dateStamp"] }, function (entries) {
          resolve(entries || []);
        });
      });

      // Entries.getAll has no error channel - a Redis read failure and a
      // genuinely empty blog both resolve to []. Cross-check against a
      // direct count so a transient failure aborts (leaving "ready" cleared
      // above, to be retried later) rather than wiping out a good index
      // with an empty one.
      var entriesCount = parseInt(
        (await isolated.zCard("blog:" + blogID + ":entries")) || 0,
        10
      );

      if (entriesCount > 0 && entries.length === 0) {
        await isolated.unwatch();
        throw new Error(
          "archives.rebuild: entries fetch returned empty for non-empty blog " +
            blogID +
            " - aborting without touching the index"
        );
      }

      var staleYearMonths = await isolated.zRange(key.months(blogID), 0, -1);

      var buckets = Object.create(null);

      entries.forEach(function (entry) {
        if (!entry || !bucket.hasDateStamp(entry)) return;

        var yearMonth = bucket.yearMonth(entry.dateStamp, blog.timeZone);

        if (!buckets[yearMonth]) buckets[yearMonth] = [];
        buckets[yearMonth].push(entry);
      });

      var multi = isolated.multi();

      staleYearMonths.forEach(function (yearMonth) {
        multi.del(key.bucket(blogID, yearMonth));
      });

      multi.del(key.months(blogID));

      Object.keys(buckets).forEach(function (yearMonth) {
        multi.zAdd(key.months(blogID), {
          score: bucket.score(yearMonth),
          value: yearMonth,
        });

        buckets[yearMonth].forEach(function (entry) {
          multi.zAdd(key.bucket(blogID, yearMonth), {
            score: entry.dateStamp,
            value: entry.id,
          });
          multi.set(key.entry(blogID, entry.id), yearMonth);
        });
      });

      multi.set(key.ready(blogID), "1");

      try {
        await multi.exec();
      } catch (err) {
        if (err instanceof WatchError && attemptsLeft > 1) {
          return attempt(attemptsLeft - 1);
        }
        throw err;
      }

      return entries.length;
    }
  })().catch(function (err) {
    callback(err);
  });
};
