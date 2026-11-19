const crypto = require("crypto");
const ensure = require("helper/ensure");

// A post's ID on Discover. Entry IDs are file paths, which can hold any
// character, so the ID is a hash of the pair rather than the pair itself.
module.exports = function postID(blogID, entryID) {
  ensure(blogID, "string").and(entryID, "string");

  return crypto
    .createHash("sha1")
    .update(blogID + "\n" + entryID)
    .digest("hex")
    .slice(0, 20);
};
