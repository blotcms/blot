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

  const views = await new Promise(function (resolve, reject) {
    getMultipleViews(name, viewNames, function (viewErr, views) {
      if (viewErr) return reject(viewErr);
      resolve(views);
    });
  });

  return { views, metadata };
};
