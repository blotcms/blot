var ensure = require("helper/ensure");
var pathNormalizer = require("helper/pathNormalizer");
var redis = require("models/client");
var get = require("./get");

// Resolve an entry path without regard to case. A live (non-deleted) match
// always wins over a same-path tombstone, so a file renamed only by case still
// resolves to its new true-case entry. The entry is returned in whatever state
// it is in (deleted/draft/scheduled) so callers can apply their own policy.
module.exports = function getByPath(blogID, path, callback) {
  ensure(blogID, "string").and(path, "string").and(callback, "function");

  var normalizedPath = pathNormalizer(path);

  get(blogID, normalizedPath, function (exactEntry) {
    // A live exact-case match is unambiguous - use it.
    if (exactEntry && !exactEntry.deleted) return callback(exactEntry);

    redis
      .zRange("blog:" + blogID + ":all", 0, -1)
      .then(function (paths) {
        var lowerPath = normalizedPath.toLowerCase();
        var candidates = (paths || []).filter(function (candidate) {
          var normalized = pathNormalizer(candidate);
          return (
            normalized !== normalizedPath &&
            normalized.toLowerCase() === lowerPath
          );
        });

        // Nothing else matches case-insensitively - fall back to the exact
        // entry even if it is a tombstone (or undefined if there is none).
        if (!candidates.length) return callback(exactEntry || undefined);

        get(blogID, candidates, function (entries) {
          entries = (entries || []).filter(Boolean);

          // Prefer a live entry at a differently-cased path; otherwise keep the
          // exact-case tombstone, then any differently-cased match.
          var live = entries.find(function (entry) {
            return !entry.deleted;
          });

          callback(live || exactEntry || entries[0] || undefined);
        });
      })
      .catch(function (err) {
        console.error(err);
        callback(exactEntry || undefined);
      });
  });
};
