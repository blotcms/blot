var pathNormalizer = require("helper/pathNormalizer");

// The Redis keys of a blog's file index. Every key starts blog:{blogID}:file
// so blog deletion's blog:{blogID}:* sweep removes the index with the rest.
// There is a key per directory, never one per file. See README.

function prefix(blogID) {
  return "blog:" + blogID + ":file";
}

module.exports = {
  // Hash: child name -> packed record (see record.js)
  dir: function (blogID, dirPath) {
    return prefix(blogID) + ":dir:" + dirPath;
  },

  // Hash: lowercased child name -> the child names it folds from, joined by
  // "/" (which no name can contain)
  lower: function (blogID, dirPath) {
    return prefix(blogID) + ":lower:" + dirPath;
  },

  // Sorted set of every path below the root, all at score 0, for subtree
  // queries with ZRANGEBYLEX (the entries:lex pattern)
  paths: function (blogID) {
    return prefix(blogID) + ":paths";
  },

  // Hash: bytes, files
  totals: function (blogID) {
    return prefix(blogID) + ":totals";
  },
};

// A path in the form the index uses: the same normalisation as entry keys
// (models/entry/key.js), so a file and its entry join on the same string.
// The folder itself is "/".
module.exports.normalize = function normalize(path) {
  return pathNormalizer(path || "/") || "/";
};
