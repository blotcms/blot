var async = require("async");
var ensure = require("helper/ensure");
var model = require("./model");
var redis = require("models/client");
var guid = require("helper/guid");
var clfdate = require("helper/clfdate");
var debug = require("debug")("blot:entry:set");
var get = require("./get");
var key = require("./key");
var format = require("./format");
var setUrl = require("./_setUrl");
var Candidates = setUrl.Candidates;
var Blog = require("models/blog");

// Queue items
var rebuildDependencyGraph = require("./_rebuildDependencyGraph");
var backlinksToUpdate = require("./_backlinksToUpdate");
var updateTagList = require("models/tags").set;
var updateArchivesIndex = require("models/archives").set;
var addToSchedule = require("./_addToSchedule");
var notifyDrafts = require("./_notifyDrafts");
var assignToLists = require("./_assign");

// Set is a private method which takes any valid
// properties in the updates param and then overwrites those.
// Also updates entry properties which affect data stored
// elsewhere such as created date, permalink etc..
module.exports = function set (blogID, path, updates, callback) {
  ensure(blogID, "string")
    .and(path, "string")
    .and(updates, "object")
    .and(callback, "function");

  var entryKey = key.entry(blogID, path);
  var entryHashKey = key.entryHash(blogID, path);
  var queue;

  debug("set", blogID, path);

  // Get the entry stored against this ID
  get(blogID, path, function (entry) {
    // Create an empty object if new entry
    entry = entry || {};

    var previousPermalink = entry.permalink;

    var previousInternalLinks = entry.internalLinks
      ? entry.internalLinks.slice()
      : [];

    var previousDependencies = entry.dependencies
      ? entry.dependencies.slice()
      : [];

    var previousUrl = entry.url;

    // Overwrite any updates to the entry
    for (var i in updates) entry[i] = updates[i];

    var dateStampWasRemoved = entry.dateStampWasRemoved;

    if (dateStampWasRemoved) {
      delete entry.dateStamp;
    }

    if (entry.guid === undefined) entry.guid = "entry_" + guid();

    // This is for new entries
    if (entry.created === undefined) {
      entry.created = Date.now();
    }

    if (entry.dateStamp === undefined) {
      entry.dateStamp = entry.created;
    }

    // ToDO remove these and ensure all existing entries have been rebuilt
    if (entry.dependencies === undefined) entry.dependencies = [];
    if (entry.backlinks === undefined) entry.backlinks = [];
    if (entry.internalLinks === undefined) entry.internalLinks = [];
    if (!entry.metadata || typeof entry.metadata !== "object") entry.metadata = {};
    if (!entry.exif || typeof entry.exif !== "object") entry.exif = {};

    entry.scheduled = entry.dateStamp > Date.now();

    delete entry.dateStampWasRemoved;

    // Draft entries should not be in the
    // menu or scheduled list
    if (entry.draft) {
      entry.menu = entry.page = entry.scheduled = false;
    }

    // Scheduled entries should not be in the menu
    if (entry.scheduled) {
      entry.menu = entry.page = false;
    }

    // Deleted entries not be in the menu,
    // drafts folder or scheduled list
    if (entry.deleted) {
      entry.menu = entry.page = entry.draft = entry.scheduled = false;
    }

    debug("set", blogID, path, "calling setUrl");

    setUrl(blogID, entry, function (err, result) {
      // Should be pretty serious (i.e. issue with DB)
      if (err) return callback(err);

      var url = result.url;
      var conflictingEntryPath = result.conflictingEntryPath;

      debug("set", blogID, path, "setUrl returned", url);

      // URL will be an empty string for
      // drafts, scheduled entries and deleted entries
      entry.url = url;

      Blog.get({ id: blogID }, function (err, blog) {
        if (err) return callback(err);
        if (!blog) return callback(new Error("Blog not found"));

        // Skip dependency tracking for deleted entries
        // to preserve entry.permalink for backlink removal
        if (!entry.deleted) {
          var firstCandidateList = Candidates(blog, entry);
          var firstCandidate = firstCandidateList && firstCandidateList[0];
          var dependenciesProvided = Array.isArray(updates.dependencies);
          var baseDependencies = dependenciesProvided
            ? updates.dependencies.slice()
            : previousDependencies.slice();

          var deduplicated =
            !!conflictingEntryPath &&
            !!firstCandidate &&
            url &&
            url !== firstCandidate;

          if (deduplicated) {
            if (entry.dependencies.indexOf(conflictingEntryPath) === -1) {
              entry.dependencies.push(conflictingEntryPath);
            }
          }

          var previousUrlWasDeduped = previousUrl && /-\d+$/.test(previousUrl);
          var reclamation =
            !!firstCandidate &&
            !!previousUrlWasDeduped &&
            url === firstCandidate;

          if (reclamation) {
            entry.dependencies = entry.dependencies.filter(function (dependency) {
              var wasPrevious = previousDependencies.indexOf(dependency) > -1;
              var inBase = baseDependencies.indexOf(dependency) > -1;

              if (!dependenciesProvided) {
                return !(previousUrlWasDeduped && dependency === conflictingEntryPath);
              }

              return !(wasPrevious && !inBase);
            });
          }
        }

        // Ensures entry has all the
        // keys it should have and no more
        ensure(entry, model, true);

        // Store the entry twice: the legacy JSON string key (authoritative
        // until the hash backfill has run everywhere) and a Redis hash, which
        // is the source of truth going forward and lets ./get.js fetch
        // individual fields with HMGET. `del` before `hSet` clears any fields
        // left behind by an older entry model.
        redis
          .multi()
          .set(entryKey, JSON.stringify(entry))
          .del(entryHashKey)
          .hSet(entryHashKey, format.serialize(entry))
          .exec()
          .then(function () {
            if (entry.deleted) {
              return redis
                .multi()
                .expire(entryKey, 24 * 60 * 60)
                .expire(entryHashKey, 24 * 60 * 60)
                .exec()
                .then(function (results) {
                  if (!results || !results[0] || !results[1])
                    throw new Error(
                      "Failed to set expiration for deleted entry"
                    );
                });
            }

            return redis.multi().persist(entryKey).persist(entryHashKey).exec();
          })
          .then(function () {
            // Re-read the blog's timezone right before reconciling the
            // archives index, rather than reusing the `blog` fetched at the
            // top of this save (before setUrl and the entry-persisting
            // multis above). Every archive bucket is keyed by year/month in
            // this timezone (see models/archives/set.js), so a save that
            // straddles a concurrent timezone change - and therefore an
            // archives rebuild - must not write into a now-stale bucket
            // using the timezone this save started with.
            return new Promise(function (resolve, reject) {
              Blog.get({ id: blogID }, function (err, currentBlog) {
                if (err) return reject(err);
                resolve(currentBlog ? currentBlog.timeZone : blog.timeZone);
              });
            });
          })
          .then(function (timeZone) {
            queue = [
              updateTagList.bind(this, blogID, entry),
              updateArchivesIndex.bind(this, blogID, entry, timeZone),
              assignToLists.bind(this, blogID, entry),
              rebuildDependencyGraph.bind(this, blogID, entry, previousDependencies),
            ];

            if (entry.scheduled)
              queue.push(addToSchedule.bind(this, blogID, entry));

            if (entry.draft) queue.push(notifyDrafts.bind(this, blogID, entry));

            async.parallel(queue, function (err) {
              if (err) return callback(err);
              backlinksToUpdate(
                blogID,
                entry,
                previousInternalLinks,
                previousPermalink,
                previousUrl,
                function (err, changes) {
                  if (err) return callback(err);

                  if (changes.length)
                    console.log(
                      clfdate(),
                      blogID.slice(0, 12),
                      "updating backlinks:",
                      path
                    );
                  async.eachOf(
                    changes,
                    function (backlinks, linkedEntryPath, next) {
                      console.log(
                        clfdate(),
                        blogID.slice(0, 12),
                        "    - linked entry:",
                        linkedEntryPath
                      );
                      set(blogID, linkedEntryPath, { backlinks }, function (err) {
                        if (err) {
                          console.log(
                            clfdate(),
                            blogID.slice(0, 12),
                            "    - error updating linked entry:",
                            linkedEntryPath
                          );
                          console.log(err);
                        }
                        next();
                      });
                    },
                    function (err) {
                      if (err) return callback(err);
                      if (entry.deleted) {
                        console.log(clfdate(), blogID.slice(0, 12), "delete", path);
                      } else {
                        console.log(clfdate(), blogID.slice(0, 12), "update", path);
                      }
                      callback();
                    }
                  );
                }
              );
            });
          })
          .catch(function (err) {
            return callback(err);
          });
      });
    });
  });
};
