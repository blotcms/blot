var client = require("models/client");
var keys = require("./key");
var dependentsKey = keys.dependents;
var dependentsExactCaseKey = keys.dependentsExactCase;
var _ = require("lodash");

// The purpose of this function is to store the
// fact that a given blog post is dependent on
// the contents of another file in the blog's folder.
// For each dependency's path, we add this entry's path
// to the set containing the dependency's dependents!
// This means when the dependency changes (even if it is
// not an entry) we can rebuild this entry.
//
// Keys are lowercased (see key.js), so two dependencies which differ only by
// case share one set. Sets written before that live under an exact-case key:
// every save re-adds the entry to the lowercased key and removes it from the
// legacy one, so rebuilding an entry migrates it.

module.exports = function (blogID, entry, previous_dependencies, callback) {
  var removed_dependencies = [];
  var current_dependencies = [];
  var multi = client.multi();

  // Since this post is no longer available, none of its current or former
  // dependencies are still dependencies. Remove everything.
  if (entry.deleted) {
    removed_dependencies = _.union(entry.dependencies, previous_dependencies);

    // Since this post exists, we need to work out which dependencies were
    // added since the last time this post was saved. We also need to work
    // out which dependencies were removed.
  } else {
    current_dependencies = entry.dependencies;
    removed_dependencies = _.difference(
      previous_dependencies,
      entry.dependencies
    );
  }

  // Dependencies which differ only by case share a key, so a removed one
  // must not take the entry out of a set a remaining one still needs.
  var wantedKeys = new Set(
    current_dependencies.map(function (path) {
      return dependentsKey(blogID, path);
    })
  );

  removed_dependencies.forEach(function (path) {
    _.uniq([
      dependentsKey(blogID, path),
      dependentsExactCaseKey(blogID, path),
    ]).forEach(function (key) {
      if (!wantedKeys.has(key)) multi.sRem(key, entry.path);
    });
  });

  // Added every time, not just for new dependencies: it is idempotent and
  // moves entries saved before keys were lowercased onto the new key.
  current_dependencies.forEach(function (path) {
    var key = dependentsKey(blogID, path);
    var legacyKey = dependentsExactCaseKey(blogID, path);

    multi.sAdd(key, entry.path);

    if (legacyKey !== key && !wantedKeys.has(legacyKey))
      multi.sRem(legacyKey, entry.path);
  });

  multi.exec().then(function () {
    return callback();
  }).catch(function (err) {
    return callback(err);
  });
};
