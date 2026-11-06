var { promisify } = require("util");
var withCallback = require("helper/withCallback");
var ensure = require("helper/ensure");

var Ignored = require("models/ignoredFiles");
var Entry = require("models/entry");

module.exports = withCallback(async function ignore(blogID, path, reason) {
  ensure(blogID, "string").and(path, "string").and(reason, "string");

  // Remove this file from the user's blog
  // and from the folder on the server.
  await promisify(Ignored.add)(blogID, path, reason);
  await promisify(Entry.drop)(blogID, path);
});
