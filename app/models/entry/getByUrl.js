var ensure = require("helper/ensure");
var redis = require("models/client");
var get = require("./get");
var urlKey = require("./key").url;

// async getByUrl(blogID, entryUrl)
//
// Resolves to the entry at the URL, or undefined if there is none. Rejects
// with the Redis error if the lookup fails, so that callers that cache the
// result (see blog/render/load/augmentedEntries.js) can tell a failed lookup
// from a URL that has no entry. Callers that don't care catch it.
module.exports = async function getByUrl(blogID, entryUrl) {
  ensure(blogID, "string").and(entryUrl, "string");

  // Normalize to decoded form so percent-encoded hrefs (e.g. from Pandoc)
  // resolve to entries stored under decoded URLs (see _setUrl.js).
  try {
    entryUrl = decodeURI(entryUrl);
  } catch (e) {
    // leave as-is if decoding fails (malformed %)
  }

  var entryID;

  try {
    entryID = await redis.get(urlKey(blogID, entryUrl));
  } catch (error) {
    console.error("entry.getByUrl: failed to resolve URL", error);
    throw error;
  }

  if (entryID === null || entryID === undefined) return;

  return await get(blogID, entryID);
};
