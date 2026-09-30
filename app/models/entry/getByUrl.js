var ensure = require("helper/ensure");
var redis = require("models/client");
var get = require("./get");
var urlKey = require("./key").url;

module.exports = function getByUrl(blogID, entryUrl, callback) {
  ensure(blogID, "string").and(entryUrl, "string").and(callback, "function");

  // Normalize to decoded form so percent-encoded hrefs (e.g. from Pandoc)
  // resolve to entries stored under decoded URLs (see _setUrl.js).
  try {
    entryUrl = decodeURI(entryUrl);
  } catch (e) {
    // leave as-is if decoding fails (malformed %)
  }

  redis
    .get(urlKey(blogID, entryUrl))
    .then(function (entryID) {
      if (entryID === null || entryID === undefined) return callback();

      get(blogID, entryID, callback);
    })
    .catch(function (error) {
      console.error("entry.getByUrl: failed to resolve URL", error);
      // Second argument lets callers that cache the result (see
      // blog/render/load/augmentedEntries.js) tell a failed lookup from a
      // URL that has no entry. Existing callers only read the first.
      callback(undefined, error);
    });
};
