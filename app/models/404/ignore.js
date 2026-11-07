var client = require("models/client");
var ensure = require("helper/ensure");
var key = require("./key");

// Resolves to the number of URLs added
async function ignore(blogID, url) {
  ensure(blogID, "string").and(url, "string");

  var ignoreKey = key.ignore(blogID);

  ensure(ignoreKey, "string");

  return await client.sAdd(ignoreKey, url);
}

const promiseOnly = require("helper/promiseOnly");

module.exports = promiseOnly(ignore);
