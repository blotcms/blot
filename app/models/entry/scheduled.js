var ensure = require("helper/ensure");
var alarm = require("helper/alarm");
var clfdate = require("helper/clfdate");
var model = require("./model");

// Publishes future-dated entries. Each scheduled entry has an alarm in Redis
// (see helper/alarm), so any process can publish it and nothing is lost when
// the process that saved it goes away. The alarm id is blogID + ":" + path;
// blog IDs contain no colon but paths may, so split on the first colon only.
//
// When the alarm fires the entry is re-saved with an empty update, which
// recomputes entry.scheduled (now false), then the blog's cache is bumped.
// Delivery is at-least-once; re-saving a published entry is harmless.

function toID(blogID, path) {
  return blogID + ":" + path;
}

function fromID(id) {
  var i = id.indexOf(":");
  return { blogID: id.slice(0, i), path: id.slice(i + 1) };
}

function getEntry(blogID, path) {
  var get = require("./get");
  return new Promise(function (resolve, reject) {
    // Entry.get calls back (entry, err); on a read error entry is undefined,
    // which must not be mistaken for "no such entry"
    get(blogID, path, function (entry, err) {
      if (err) reject(err);
      else resolve(entry);
    });
  });
}

function setEntry(blogID, path) {
  var set = require("./set");
  return new Promise(function (resolve, reject) {
    set(blogID, path, {}, function (err) {
      if (err) reject(err);
      else resolve();
    });
  });
}

function bumpCacheID(blogID) {
  var Blog = require("models/blog");
  return new Promise(function (resolve, reject) {
    Blog.bumpCacheID(blogID, function (err) {
      if (err) reject(err);
      else resolve();
    });
  });
}

var alarms = alarm(
  "scheduled-entries",
  async function handler(id) {
    var parsed = fromID(id);
    var blogID = parsed.blogID;
    var path = parsed.path;
    var entry = await getEntry(blogID, path);

    // Gone, deleted or drafted: nothing to publish. An entry that is already
    // unscheduled may be a publication that failed part way (the re-save ran
    // but a later step didn't), so it falls through and is re-saved, which is
    // harmless for one that was published fine.
    if (!entry || entry.deleted || entry.draft) return;

    // Rescheduled to a later date since this alarm was set
    if (entry.dateStamp > Date.now()) {
      // A save can land between our read and our set, and its own hook may
      // already have run, so our set would leave its older date behind. Re-read
      // and correct until stable: the saver's hook runs after its write, so
      // this converges on the newest state.
      for (var attempt = 0; attempt < 3; attempt++) {
        await alarms.set(id, entry.dateStamp);
        var latest = await getEntry(blogID, path);

        if (!latest || !latest.scheduled) {
          await alarms.cancel(id);
          break;
        }

        if (latest.dateStamp === entry.dateStamp) break;

        entry = latest;
      }
      return;
    }

    // The alarm survives the re-save (see addToSchedule) and is removed by the
    // alarm helper only when this handler returns, i.e. after the whole
    // publication. If a step fails, push the alarm out by RETRY_MS so a later
    // poll retries, then rethrow. Not for right now, or the same poll would
    // claim it again and spin on a failure.
    try {
      await setEntry(blogID, path);
      await bumpCacheID(blogID);
    } catch (err) {
      await alarms.set(id, Date.now() + module.exports.RETRY_MS);
      throw err;
    }

    console.log(clfdate(), "Blog:", blogID + ":", "Published entry as scheduled!", path);
  },
  { pollMs: 5000 }
);

// Called from entry.set for every save. Arms the alarm if the entry is
// scheduled; cancels it if the entry is a draft, deleted or gone. A published
// entry (date now in the past) is left alone: the alarm handler removes its
// own alarm only once the whole publication (re-save and cache bump) has
// succeeded, so a process that exits mid-publish leaves the claimed alarm to
// be retried after its lease. A stray alarm for an already published entry
// just re-saves it (idempotent) when it fires, then completes.
function addToSchedule(blogID, entry, callback) {
  ensure(blogID, "string").and(entry, model).and(callback, "function");

  var id = toID(blogID, entry.path);
  var done;

  if (entry.scheduled) done = alarms.set(id, entry.dateStamp);
  else if (entry.draft || entry.deleted) done = alarms.cancel(id);
  else done = Promise.resolve();

  done.then(function () {
    callback();
  }, callback);
}

// Safety net for alarms that went missing or stale (a lost race, a flush, an
// entry scheduled before alarms existed): for every blog, makes sure each
// entry in the scheduled list has an alarm at its dateStamp. Only writes
// missing or different alarms. Resolves to counts; a blog that fails is
// logged and counted, and the rest carry on.
async function reconcile() {
  var Blog = require("models/blog");
  var Entries = require("models/entries");
  var Entry = require("./index");

  var blogIDs = await new Promise(function (resolve, reject) {
    Blog.getAllIDs(function (err, ids) {
      if (err) reject(err);
      else resolve(ids);
    });
  });

  // Entries.get swallows failures into an empty list; getListIDs and Entry.get
  // report them, so a read failure is counted rather than mistaken for "none"
  function scheduledEntries(blogID) {
    return new Promise(function (resolve, reject) {
      Entries.getListIDs(blogID, "scheduled", {}, function (err, ids) {
        if (err) return reject(err);
        if (!ids.length) return resolve([]);
        Entry.get(blogID, ids, function (entries, err) {
          if (err) reject(err);
          else resolve(entries);
        });
      });
    });
  }

  var counts = { blogs: 0, set: 0, failed: 0 };

  for (var blogID of blogIDs) {
    counts.blogs++;

    try {
      var entries = await scheduledEntries(blogID);

      for (var entry of entries) {
        if (!entry.scheduled) continue;

        var id = toID(blogID, entry.path);
        var current = await alarms.when(id);

        if (current === null || current !== entry.dateStamp) {
          await alarms.set(id, entry.dateStamp);
          counts.set++;
        }
      }
    } catch (err) {
      counts.failed++;
      console.error(
        clfdate(),
        "Blog:",
        blogID + ":",
        "Could not reconcile scheduled entries:",
        (err && err.message) || err
      );
    }
  }

  return counts;
}

addToSchedule.alarm = alarms;
addToSchedule.toID = toID;
addToSchedule.fromID = fromID;

module.exports = addToSchedule;
module.exports.reconcile = reconcile;
module.exports.RETRY_MS = 30 * 1000;
