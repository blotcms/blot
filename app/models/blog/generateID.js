var { v4: uuid } = require("uuid");
var PREFIX = "blog_";

// uuid() returns a hex encoded 128 bit decimal.
// We want a lowercase (numbers + a-f) ID to make
// interacting with files on a case-sensitive fs
// a little easier, since it'll be part of a path.
// the id does contain dashes, which we remove. We add
// the prefix 'blog_' to make reading logs easier.

module.exports = function () {
  var id = uuid().split("-").join("");

  return PREFIX + id;
};
