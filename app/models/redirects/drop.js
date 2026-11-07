var client = require("models/client");
var ensure = require("helper/ensure");
var key = require("./key");

module.exports = async function drop(blogID, from) {
  ensure(blogID, "string").and(from, "string");

  var redirects = key.redirects(blogID);
  var fromKey = key.redirect(blogID, from);

  await client.zRem(redirects, from);
  await client.del(fromKey);
};
