var client = require("models/client");
var ensure = require("helper/ensure");
var withCallback = require("helper/withCallback");
var key = require("./key");

// Resolves to the number of URLs removed
module.exports = withCallback(async function unignore(blogID, url) {
  ensure(blogID, "string").and(url, "string");

  var ignoreKey = key.ignore(blogID);

  ensure(ignoreKey, "string");

  return await client.sRem(ignoreKey, url);
});
