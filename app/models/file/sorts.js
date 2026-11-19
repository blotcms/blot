var key = require("./key");

// The orders a directory's children are indexed in, beside the names set.
// Each is a sorted set per directory (key.sort), all at score 0, so a page
// in that order is a range of it. The writers in index.js, rebuild and the
// backfill (checkSorts) all read this list, so a new order is a new entry
// here and a run of scripts/storage/add-file-index-sorts.js --order <name>.
//
// - name: the order's part of the key, and what the backfill's --order takes
// - holds(entry): whether a child ({ name, type }) belongs in the set
// - member(name): how the child is spelled in it
module.exports = [
  {
    // Every child, in natural name order (key.sortMember)
    name: "all",
    holds: function () {
      return true;
    },
    member: key.sortMember,
  },
];
