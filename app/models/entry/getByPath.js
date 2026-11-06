var ensure = require("helper/ensure");
var pathNormalizer = require("helper/pathNormalizer");
var redis = require("models/client");
var get = require("./get");

// async getByPath(blogID, path)
//
// Resolve an entry path without regard to case. A live (non-deleted) match
// always wins over a same-path tombstone, so a file renamed only by case still
// resolves to its new true-case entry. The entry is returned in whatever state
// it is in (deleted/draft/scheduled) so callers can apply their own policy.
//
// Resolves to the entry, or undefined if there is none. Never rejects for a
// Redis failure: a failed read is treated as finding nothing.
module.exports = async function getByPath(blogID, path) {
  ensure(blogID, "string").and(path, "string");

  var normalizedPath = pathNormalizer(path);

  // A failed read is the same as no entry here
  var exactEntry = await get(blogID, normalizedPath).catch(function () {});

  // A live exact-case match is unambiguous - use it.
  if (exactEntry && !exactEntry.deleted) return exactEntry;

  var paths;

  try {
    paths = await redis.zRange("blog:" + blogID + ":all", 0, -1);
  } catch (err) {
    console.error(err);
    return exactEntry || undefined;
  }

  var lowerPath = normalizedPath.toLowerCase();
  var candidates = (paths || []).filter(function (candidate) {
    var normalized = pathNormalizer(candidate);
    return (
      normalized !== normalizedPath && normalized.toLowerCase() === lowerPath
    );
  });

  // Nothing else matches case-insensitively - fall back to the exact
  // entry even if it is a tombstone (or undefined if there is none).
  if (!candidates.length) return exactEntry || undefined;

  // A failed read is the same as no entries here
  var entries = await get(blogID, candidates).catch(function () {
    return [];
  });

  entries = (entries || []).filter(Boolean);

  // Prefer a live entry at a differently-cased path; otherwise keep the
  // exact-case tombstone, then any differently-cased match.
  var live = entries.find(function (entry) {
    return !entry.deleted;
  });

  return live || exactEntry || entries[0] || undefined;
};
