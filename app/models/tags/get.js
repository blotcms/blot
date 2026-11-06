var normalize = require("./normalize");
var get = require("./_get");

// This is the method exposed publicly
// It checks a few variants of the tag
// until it finds one that works.
// It first tries the normalized tag,
// then the tag as it was entered,
// then the tag as it was entered but decoded, e.g.
// "Hello%20World" -> "Hello World"
// Resolves to { entryIDs, prettyTag, total }.
module.exports = async function (blogID, tag, options = {}) {
  options = options || {};

  let normalizedTag = tag;
  let decodedTag = tag;

  try {
    normalizedTag = normalize(tag);
  } catch (e) {
    // do nothing if normalization fails
  }

  try {
    decodedTag = decodeURIComponent(tag);
  } catch (e) {
    // do nothing if decoding fails
  }

  let result = await get(blogID, normalizedTag, options);

  if (result.entryIDs && result.entryIDs.length) return result;

  result = await get(blogID, tag, options);

  if (result.entryIDs && result.entryIDs.length) return result;

  return get(blogID, decodedTag, options);
};
