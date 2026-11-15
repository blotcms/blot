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

  // Sorted set of a directory's children in one of the orders in sorts.js,
  // all at score 0, members as that order spells them. The v1 is the member
  // format: a change to it is a new key and a backfill, never a rewrite in
  // place. Missing for a directory no writer has built it for yet, which is
  // then read whole: see README.
  sort: function (blogID, order, dirPath) {
    return prefix(blogID) + ":sort:v1:" + order + ":" + dirPath;
  },

  // Where the backfill builds a directory's sorted set before renaming it
  // into place, so a run killed part way never leaves a partial set
  sortBuild: function (blogID, order, dirPath) {
    return prefix(blogID) + ":sort:build:" + order + ":" + dirPath;
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

// A child's member in the natural-order sets (sort:v1): a group, a sort key,
// NUL, then the name itself. Byte order of members (ZRANGEBYLEX, or
// Buffer.compare in Node) is the order a file browser shows: case and common
// accents ignored, runs of digits compared by value (IMG_2 before IMG_10),
// digits before letters and punctuation, and names hidden everywhere
// (dotfiles, .preview.html) after the rest. The name breaks ties, so names
// that differ only in case keep code-unit order (uppercase first), and it
// can be read back from the member (nameOfSorted).
//
// The sort key: the name in NFD with combining diacritics (U+0300 to U+036F
// only, so other scripts' marks still count) and control characters
// dropped, lowercased, and each run of digits written as \x01, its length
// without leading zeros as one code point (length + 1), the digits without
// leading zeros, then 0x1000 minus the number of leading zeros as one code
// point, so more leading zeros sort first, as the dashboard has always
// ordered them. A name is at most 1,024 bytes, so neither code point can
// reach NUL or a surrogate, and no run is ever split.
var DIACRITICS = /[\u0300-\u036f]/g;
// eslint-disable-next-line no-control-regex -- it is meant to match control characters
var CONTROLS = /[\u0000-\u001f]/g;
var DIGITS = /[0-9]+/g;

function hiddenEverywhere(name) {
  return name.startsWith(".") || name.endsWith(".preview.html");
}

function sortKey(name) {
  return name
    .normalize("NFD")
    .replace(DIACRITICS, "")
    .replace(CONTROLS, "")
    .toLowerCase()
    .replace(DIGITS, function (run) {
      var digits = run.replace(/^0+/, "");
      var zeros = run.length - digits.length;

      return (
        "\u0001" +
        String.fromCodePoint(digits.length + 1) +
        digits +
        String.fromCodePoint(0x1000 - zeros)
      );
    });
}

module.exports.hiddenEverywhere = hiddenEverywhere;

module.exports.sortMember = function sortMember(name) {
  return (
    (hiddenEverywhere(name) ? "\u0002" : "\u0001") +
    sortKey(name) +
    "\u0000" +
    name
  );
};

// The name a sorted member spells: everything after the first NUL, since
// neither the group nor the sort key ever holds one
module.exports.nameOfSorted = function nameOfSorted(member) {
  return member.slice(member.indexOf("\u0000") + 1);
};

// Compares two members as Redis does, by UTF-8 bytes
module.exports.compareSorted = function compareSorted(a, b) {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
};
