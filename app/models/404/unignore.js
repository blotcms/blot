var client = require("models/client");
var ensure = require("helper/ensure");
var key = require("./key");

// Resolves to the number of URLs removed
module.exports = async function unignore(blogID, url) {
  ensure(blogID, "string").and(url, "string");

  var ignoreKey = key.ignore(blogID);

  ensure(ignoreKey, "string");

  return await client.sRem(ignoreKey, url);
};
