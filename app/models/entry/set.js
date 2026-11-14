var ensure = require("helper/ensure");
var model = require("./model");
var redis = require("models/client");
var guid = require("helper/guid");
var clfdate = require("helper/clfdate");
var debug = require("debug")("blot:entry:set");
var get = require("./get");
var key = require("./key");
var setUrl = require("./_setUrl");
var Candidates = setUrl.Candidates;
var Blog = require("models/blog");
var isEqual = require("lodash").isEqual;

// Queue items
var rebuildDependencyGraph = require("./_rebuildDependencyGraph");
var backlinksToUpdate = require("./_backlinksToUpdate");
var updateTagList = require("models/tags").set;
var addToSchedule = require("./scheduled");
var notifyDrafts = require("./_notifyDrafts");
var assignToLists = require("./_assign");
var { DELETED_ENTRY_TTL_SECONDS } = require("../entries/sweepExpiredDeleted");

// Set is a private method which takes any valid
// properties in the updates param and then overwrites those.
// Also updates entry properties which affect data stored
// elsewhere such as created date, permalink etc..
//
// Resolves to { changed }. Rejects with the error that stopped the save.
async function set(blogID, path, updates) {
  ensure(blogID, "string").and(path, "string").and(updates, "object");

  var entryKey = key.entry(blogID, path);

  debug("set", blogID, path);

  // Get the entry stored against this ID. A failed read is not a new entry:
  // carrying on would overwrite the stored one, and the caller (e.g. a
  // scheduled publish) needs the Redis error.
  var entry = await get(blogID, path);

  // What is stored now, to tell the caller whether this set changed it.
  // Compared as data, not as a string: a stored entry's keys are in the
  // order its build produced them, a re-read one's in Entry's.
  var stored = entry ? JSON.parse(JSON.stringify(entry)) : null;

  // Create an empty object if new entry
  entry = entry || {};

  var previousPermalink = entry.permalink;

  // So an entry that stops being scheduled (drafted, deleted) cancels its alarm
  var wasScheduled = !!entry.scheduled;

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
  if (!entry.metadata || typeof entry.metadata !== "object")
    entry.metadata = {};
  if (!entry.exif || typeof entry.exif !== "object") entry.exif = {};
  if (typeof entry.caption !== "string") entry.caption = "";
  if (typeof entry.contentHash !== "string") entry.contentHash = "";

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

  // A rejection here should be pretty serious (i.e. issue with DB)
  var result = await setUrl(blogID, entry);
  var url = result.url;
  var conflictingEntryPath = result.conflictingEntryPath;

  debug("set", blogID, path, "setUrl returned", url);

  // URL will be an empty string for
  // drafts, scheduled entries and deleted entries
  entry.url = url;

  var blog = await Blog.get({ id: blogID });

  if (!blog) throw new Error("Blog not found");

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
      !!firstCandidate && !!previousUrlWasDeduped && url === firstCandidate;

    if (reclamation) {
      entry.dependencies = entry.dependencies.filter(function (dependency) {
        var wasPrevious = previousDependencies.indexOf(dependency) > -1;
        var inBase = baseDependencies.indexOf(dependency) > -1;

        if (!dependenciesProvided) {
          return !(
            previousUrlWasDeduped && dependency === conflictingEntryPath
          );
        }

        return !(wasPrevious && !inBase);
      });
    }
  }

  // Ensures entry has all the
  // keys it should have and no more
  ensure(entry, model, true);

  var json = JSON.stringify(entry);

  // Store the entry
  await redis.set(entryKey, json);

  if (entry.deleted) {
    var expired = await redis.expire(entryKey, DELETED_ENTRY_TTL_SECONDS);

    if (!expired) throw new Error("Failed to set expiration for deleted entry");
  } else {
    await redis.persist(entryKey);
  }

  // These all start at once and run in parallel. updateTagList is first.
  var queue = [
    updateTagList(blogID, entry),
    assignToLists(blogID, entry),
    rebuildDependencyGraph(blogID, entry, previousDependencies),
  ];

  // Arms the publication alarm, or cancels it when a scheduled entry
  // becomes a draft or is deleted. Other saves skip the Redis round
  // trip.
  if (entry.scheduled || wasScheduled) queue.push(addToSchedule(blogID, entry));

  if (entry.draft) queue.push(notifyDrafts(blogID, entry));

  var results = await Promise.all(queue);

  var tagsChanged = !!(results[0] && results[0].changed);

  var changes = await backlinksToUpdate(
    blogID,
    entry,
    previousInternalLinks,
    previousPermalink,
    previousUrl
  );

  // An object of linked entry path -> backlinks
  var backlinksMoved = Object.keys(changes).length > 0;

  if (backlinksMoved)
    console.log(clfdate(), blogID.slice(0, 12), "updating backlinks:", path);

  // All the linked entries are updated in parallel. A failure to update one
  // is logged and doesn't fail this save.
  await Promise.all(
    Object.keys(changes).map(async function (linkedEntryPath) {
      console.log(
        clfdate(),
        blogID.slice(0, 12),
        "    - linked entry:",
        linkedEntryPath
      );

      try {
        await set(blogID, linkedEntryPath, {
          backlinks: changes[linkedEntryPath],
        });
      } catch (err) {
        console.log(
          clfdate(),
          blogID.slice(0, 12),
          "    - error updating linked entry:",
          linkedEntryPath
        );
        console.log(err);
      }
    })
  );

  if (entry.deleted) {
    console.log(clfdate(), blogID.slice(0, 12), "delete", path);
  } else {
    console.log(clfdate(), blogID.slice(0, 12), "update", path);
  }

  // changed: false when the stored entry is exactly as
  // it was, no other entry's backlinks moved and no tag
  // data changed, so nothing a render reads differs
  return {
    changed:
      backlinksMoved || tagsChanged || !isEqual(stored, JSON.parse(json)),
  };
}

module.exports = set;
