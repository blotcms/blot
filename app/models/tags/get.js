var normalize = require("./normalize");
var get = require("./_get");

// This is the method exposed publicly
// It checks a few variants of the tag
// until it finds one that works.
// It first tries the normalized tag,
// then the tag as it was entered,
// then the tag as it was entered but decoded, e.g.
// "Hello%20World" -> "Hello World"
module.exports = function (blogID, tag, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }

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

  get(
    blogID,
    normalizedTag,
    options,
    function (err, entryIDs, prettyTag, total) {
      if (err) return callback(err);

      if (entryIDs && entryIDs.length) {
        return callback(null, entryIDs, prettyTag, total);
      }

      get(blogID, tag, options, function (err, entryIDs, prettyTag, total) {
        if (err) return callback(err);

        if (entryIDs && entryIDs.length) {
          return callback(null, entryIDs, prettyTag, total);
        }

        get(blogID, decodedTag, options, callback);
      });
    }
  );
};
