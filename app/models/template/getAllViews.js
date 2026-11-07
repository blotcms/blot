var key = require("./key");
var client = require("models/client");
var ensure = require("helper/ensure");
var getMultipleViews = require("./getMultipleViews");
var getMetadata = require("./getMetadata");

// Resolves to { views, metadata }. Rejects with an ENOENT error when the
// template has no metadata.
module.exports = async function getAllViews(name) {
  ensure(name, "string");

  const viewNames = await client.sMembers(key.allViews(name));
  const metadata = await getMetadata(name);

  const views = await getMultipleViews(name, viewNames);

  return { views, metadata };
};
