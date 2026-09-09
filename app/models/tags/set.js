var client = require("models/client");
var key = require("./key");
var _ = require("lodash");
var ensure = require("helper/ensure");
var normalize = require("./normalize");
var model = require("../entry/model");

// a normalized tag is lowercased, and can be part of a url

// get previous normalized tags for entry

//   compute new tags
//   compute removed tags

//   for each new tag
//     store the tag against the normalized tag
//     add the entry ID to the normalized tag set

//   for each removed tag
//     remove the entry ID from the normalized tag set

// to retrieve all the entrys for a tag
// SMEMBERS the normalized tag
// lookup original tag against normalized tag

module.exports = function (blogID, entry, callback) {
  ensure(blogID, "string").and(entry, model).and(callback, "function");

  // Clone the list of tags
  var prettyTags = entry.tags.slice();

  prettyTags = prettyTags.filter(function (tag) {
    return tag && tag.trim && tag.trim().length;
  });

  // Remove the tags from a hiddden entry before saving, so it doesn't
  // show up in the tag search results page. Entry has already been set
  var hide = shouldHide(entry);

  if (hide) {
    prettyTags = [];
  }

  var normalizedMap = Object.create(null);
  var uniquePrettyTags = [];
  var tags = [];

  // First we make a slug from each tag name so that duplicates collapse and can
  // be part of a url
  prettyTags.forEach(function (tag) {
    var normalized = normalize(tag);

    if (normalizedMap[normalized]) return;

    normalizedMap[normalized] = tag;
    uniquePrettyTags.push(tag);
    tags.push(normalized);
  });

  if (!hide) {
    prettyTags = uniquePrettyTags;
  } else {
    tags = [];
  }

  var existingKey = key.entry(blogID, entry.id);

  // First we retrieve a list of all the tags used
  // across the user's blog
  (async function () {
    try {
      var existing = (await client.sMembers(existingKey)) || [];

      // Then we compute a list of tags which the entry
      // should NOT be present on (intersection of entry's
      // current tags and all the tags used on the blog)
      var removed = _.difference(existing, tags);
      var added = _.difference(tags, existing);

      var multi = client.multi();
      var popularityKey = key.popular(blogID);

      added.forEach(function (tag) {
        multi.zIncrBy(popularityKey, 1, tag);
      });

      tags.forEach(function (tag, i) {
        var score = entry.dateStamp;
        if (typeof score !== "number" || isNaN(score)) {
          score = Date.now();
        }

        multi.set(key.name(blogID, tag), prettyTags[i]);
        multi.zAdd(key.sortedTag(blogID, tag), {
          score: score,
          value: entry.id,
        });
      });

      // For each tagName in the list of tags which the
      // entry is NOT on, make sure that is so. This is
      // neccessary when the user updates an entry and
      // removes a previously existing tag
      removed.forEach(function (tag) {
        multi.zRem(key.sortedTag(blogID, tag), entry.id);
        multi.sRem(existingKey, tag);
        multi.zIncrBy(popularityKey, -1, tag);
      });

      // Finally add all the entry's tags to the
      // list of tags used across the blog...
      if (tags.length) {
        multi.sAdd(key.all(blogID), tags);
        multi.sAdd(existingKey, tags);
      }

      multi.zRemRangeByScore(popularityKey, "-inf", 0);

      await multi.exec();

      callback();
    } catch (err) {
      callback(err);
    }
  })();
};

// we need a better way to determine if we should ignore the entry (i.e. if has an underscore in its path)

function shouldHide(entry) {
  return (
    entry.deleted ||
    entry.draft ||
    entry.scheduled ||
    entry.page ||
    entry.menu ||
    entry.path.split("/").filter(function (i) {
      return i[0] === "_";
    }).length
  );
}
