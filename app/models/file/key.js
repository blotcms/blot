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

  // Sorted set of a directory's child names, all at score 0, so a page of
  // the directory in name order is one ZRANGEBYLEX. Members are the names as
  // member() below spells them. Missing for a directory last changed before
  // this key existed, which is then read whole: see README.
  names: function (blogID, dirPath) {
    return prefix(blogID) + ":names:" + dirPath;
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

// Directory listings sort names by UTF-16 code unit, as JavaScript compares
// strings and as the local backend sorts. ZRANGEBYLEX compares UTF-8 bytes,
// which is code point order, and the two differ in one place: a character
// from U+E000 to U+FFFF sorts before every character beyond U+FFFF by code
// point, and after them by code unit (those are surrogate pairs, D800 to
// DFFF). So a names member spells each such character with U+10FFFF, the
// highest code point, in front of it, and U+10FFFF itself as U+10FFFF then
// NUL, which sorts both after everything else beyond U+FFFF, in their own
// order. Any other name, which is nearly every name, is its own member.
var HIGH = /[-￿]|\u{10FFFF}/gu;
var ESCAPED = /\u{10FFFF}([\s\S])/gu;

module.exports.member = function member(name) {
  return name.replace(HIGH, function (c) {
    return c === "\u{10FFFF}" ? "\u{10FFFF}\u0000" : "\u{10FFFF}" + c;
  });
};

// The name a names member spells
module.exports.nameOf = function nameOf(member) {
  return member.replace(ESCAPED, function (match, c) {
    return c === "\u0000" ? "\u{10FFFF}" : c;
  });
};
