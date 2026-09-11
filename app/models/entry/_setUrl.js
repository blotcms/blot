var async = require("async");
var ensure = require("helper/ensure");
var _ = require("lodash");
var urlNormalizer = require("helper/urlNormalizer");
var UID = require("helper/makeUid");
var makeSlug = require("helper/makeSlug");
var metadataCaseInsensitive = require("helper/metadataCaseInsensitive");
var withoutExtension = require("helper/withoutExtension");
var redis = require("models/client");
var Permalink = require("build/prepare/permalink");
var Key = require("./key").url;
var model = require("./model");
var Blog = require("models/blog");
var get = require("./get");
var debug = require("debug")("blot:entry:set");

var MIN_SUMMARY_SLUG_WORDS = 3;
var MAX_SUMMARY_SLUG_WORDS = 10;

var PERMALINK_PERMUTATIONS = 5;

// The random permalinks are
// this long. I figure 3 gives
// us (26 * 2 + 10)^3 (= 238,328)
// possible permalinks which is more
// than enough for one blog, espcially
// since the circumstances under
// which Blot needs to generate
// a random url are rare enough.
// It also avoids the issue of rude
// 4 letter words being generated.
var UID_LENGTH = 3;

// We generate this number
// of random permalinks in
// case all else fails.
var UID_PERMUTATIONS = 500;

// console.log(Candidates({
//   permalink: '',
//   slug: '',
//   summary: '',
//   url: '',
//   name: 'a.jpg',
//   path: '/a.jpg'
// }));

// A folder post ("Album+") is synthesized at the plus-stripped path
// ("/album") where no source file exists, so unlike a real file it is
// allowed to claim that exact path as its URL.
function isFolderPostEntry(entry) {
  return (
    entry &&
    typeof entry.html === "string" &&
    entry.html.indexOf('class="multi-file-post"') !== -1
  );
}

function Candidates(blog, entry) {
  var candidates = [];
  var metadataByLowercaseKey = metadataCaseInsensitive(entry.metadata);
  var folderPost = isFolderPostEntry(entry);

  var format = blog.permalink.isCustom ? blog.permalink.custom : blog.permalink.format;
  
  // Don't use the permalink format for pages
  // or posts with user specified permalinks.
  if (
    !metadataByLowercaseKey.permalink &&
    !metadataByLowercaseKey.link &&
    !metadataByLowercaseKey.url &&
    !entry.page
  ) {
    entry.permalink = Permalink(blog.timeZone, format, entry);
    debug("Permalink", entry.permalink);
  }

  // The user has specified a permalink in the
  // entry's metadata. We should use this if we can.
  if (entry.permalink) {
    candidates.push(entry.permalink);

    // If the permalink is unavailable, try appending a number
    // e.g. if 'apple', try 'apple-2', 'apple-3' ... 'apple-99'
    for (var i = 2; i < PERMALINK_PERMUTATIONS; i++)
      candidates.push(entry.permalink + "-" + i);
  }

  // This is generated from the entry's title
  if (entry.slug) {
    candidates.push(entry.slug);
  }

  if (entry.name) candidates.push(makeSlug(withoutExtension(entry.name)));

  if (entry.path)
    candidates.push(
      makeSlug(withoutExtension(entry.path.split("/").join("-")))
    );

  if (entry.summary) {
    var words = entry.summary.split(" ");

    for (
      var y = MIN_SUMMARY_SLUG_WORDS;
      y < words.length && y < MAX_SUMMARY_SLUG_WORDS;
      y++
    ) {
      candidates.push(makeSlug(words.slice(0, y).join("-")));
    }
  }

  // If we make it path the permalink chosen by the
  // user, it's possible that we fell through to the
  // randomly generated (UID()...) permalinks below.
  // If so, we should insert the entry's previous URL
  // if it exists to ensure that the entry retains
  // a randomly generated URL consistently.
  if (entry.url) candidates.push(entry.url);

  for (var j = 0; j < UID_PERMUTATIONS; j++) candidates.push(UID(UID_LENGTH));

  // Trim, lowercase, strip trailing /, add leading /
  // ensure valid url pathname. Always returns a string
  // can be empty if invalid or just '/'
  candidates = candidates.map(urlNormalizer);

  // We store the decoded version. Not sure if this is a good idea
  // or not but it works for now. Pandoc *en*codes by default.
  // Perhaps I could store both?
  candidates = candidates.map(function (url) {
    try {
      url = decodeURI(url);
    } catch (e) {
      console.log("Error: Could not decodeURIComponent for:", url, e.message);
    }

    return url;
  });

  candidates = candidates.filter(function (candidate) {
    // Will catch empty strings, null, undefined, etc.
    if (!candidate) return false;

    // WE DONT EVER ADD ENTRY.PATH so images are always accessible
    // It's possible that entry.name when normalized === entry.path
    // Folder posts are the exception: their path is synthesized and has
    // no file behind it, so they may use their plus-stripped path as URL.
    if (entry.path && candidate === entry.path && !folderPost) return false;

    // Otherwise we are pretty liberal: we allow posts and pages 
    // to have the same URL as a template view. This lets us set 
    // an index page for example directly from the folder using 
    // the metadata `Link: /`. Think carefuly before changing this.
    return true;
  });

  candidates = _.uniq(candidates);

  return candidates;
}

function check(blogID, candidate, entryID, callback) {
  var key = Key(blogID, candidate);

  redis
    .get(key)
    .then(function (existingID) {
      // This url is available and unused
      if (!existingID) return callback(null, false, null);

      // This url points to this entry already
      if (existingID === entryID) return callback(null, false, null);

      // This url points to a different entry
      get(blogID, existingID, function (existingEntry) {
        // For some reason (bug) the url key was
        // set but the entry does not exist. Claim the url.
        if (!existingEntry) return callback(null, false, null);

        // The existing entry has since moved to a different url
        // (perhaps the author modified its permalink etc...)
        // so this entry can claim this url.
        if (existingEntry.url !== candidate) return callback(null, false, null);

        // The existing entry was deleted after claiming this
        // url, so this entry can claim it.
        if (existingEntry.deleted) return callback(null, false, null);

        // If we reach this far down, it means the entry
        // which has claimed this url is still visible and
        // still uses this url, so we can't claim it.
        return callback(null, true, existingEntry.path);
      });
    })
    .catch(function (err) {
      return callback(err);
    });
}

// this needs to return an error if something went wrong
// and the finalized, stored url to the entry...
function setUrl(blogID, entry, callback) {
  ensure(blogID, "string").and(entry, "object").and(callback, "function");

  try {
    ensure(entry, model);
  } catch (e) {
    return callback(e);
  }

  if (entry.metadata === undefined) {
    console.log(
      "Error: Blog:",
      blogID,
      "Entry.setURL: Entry metadata is unexpectedly undefined",
      entry
    );
    return callback(null, { url: "", conflictingEntryPath: null });
  }

  debug("Setting url for", entry.path);

  if (entry.draft || entry.deleted)
    return callback(null, { url: "", conflictingEntryPath: null });

  Blog.get({ id: blogID }, function (err, blog) {
    if (err) return callback(err);

    if (!blog) return callback(new Error("Blog not found"));

    var candidates = Candidates(blog, entry);
    var firstCandidate = candidates[0];
    var firstCandidateTaken = false;
    var firstCandidateConflictingPath = null;

    // does This cause a memory leak? we sometimes
    // exist before calling all the next functions
    // if we find a successful candidate.
    async.eachOfSeries(
      candidates,
      function (candidate, index, next) {
        debug("Checking candidate", candidate);
        check(blogID, candidate, entry.id, function (
          err,
          taken,
          conflictingEntryPath
        ) {
          if (err) return callback(err);

          if (taken) {
            if (index === 0) {
              firstCandidateTaken = true;
              firstCandidateConflictingPath = conflictingEntryPath;
            }

            return next();
          }

          var key = Key(blogID, candidate);

          redis
            .set(key, entry.id)
            .then(function () {
              return callback(null, {
                url: candidate,
                conflictingEntryPath:
                  firstCandidateTaken && candidate !== firstCandidate
                    ? firstCandidateConflictingPath
                    : null,
              });
            })
            .catch(function (err) {
              return callback(err);
            });
        });
      },
      function () {
        // if we exhaust the list of candidates, what should happen?
        // just return an error for now... TODO in future, just keep
        // generating UIDS... but whatever for now.
        callback(new Error("Could not find a permalink for " + entry.path));
      }
    );
  });
}

module.exports = setUrl;
module.exports.Candidates = Candidates;
