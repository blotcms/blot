var Tags = require("models/tags");
var Entry = require("models/entry");
var withCallback = require("helper/withCallback");
var client = require("models/client");
var entryKey = require("models/entry/key").entry;

// Resolves when the commands queued on multi have run. The callback is
// still handed to multi.exec, as it always was: node-redis 6 does not call
// it but takes it as its execAsPipeline argument, so the commands are sent
// as a pipeline, not wrapped in MULTI/EXEC. That is kept as it was. Whichever
// way exec answers, this settles once.
function execTransaction(multi) {
  return new Promise(function (resolve, reject) {
    var done = false;
    function onDone(err) {
      if (done) return;
      done = true;
      if (err) return reject(err);
      resolve();
    }

    var result;
    try {
      result = multi.exec(onDone);
    } catch (err) {
      return onDone(err);
    }

    if (result && typeof result.then === "function") {
      Promise.resolve(result).then(function () {
        onDone();
      }, onDone);
    }
  });
}

// Runs iteratee on each item, at most limit at a time, starting them in the
// order of items. Stops starting new ones after the first failure, which it
// rejects with at once (the others already running finish on their own), as
// async.eachLimit did.
async function eachLimit(items, limit, iteratee) {
  var next = 0;
  var failed = false;

  async function worker() {
    while (!failed && next < items.length) {
      var item = items[next++];

      try {
        await iteratee(item);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  }

  var workers = [];

  for (var i = 0; i < Math.min(limit, items.length); i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
}

// entryIDs can run into the thousands across a blog's tags, and the same
// entry is frequently a member of several tags - an entry with 8 tags used
// to be read from Redis in full 8 times in one run. This memoises only the
// small fields needed to detect a ghost (id) per entryID for the lifetime
// of a single tag-ghosts call, and fetches unresolved ids in batched MGETs
// (preserving index alignment, unlike Entry.get which filters out missing
// entries) rather than one GET per id. Only hits are memoised: a miss is
// re-read for each tag, so an entry a concurrent sync restores mid-run isn't
// pruned from later tags. Each MGET reply holds whole entries and shares a
// connection with the lock heartbeat, so a batch is kept to the 20 full
// reads the previous version had in flight at once.
var BATCH_SIZE = 20;

async function resolveEntryIDs(blogID, entryIDs, resolved) {
  var unresolved = entryIDs.filter(function (id) {
    return !resolved.has(id);
  });

  var batches = [];
  for (var i = 0; i < unresolved.length; i += BATCH_SIZE) {
    batches.push(unresolved.slice(i, i + BATCH_SIZE));
  }

  for (const batch of batches) {
    var keys = batch.map(function (id) {
      return entryKey(blogID, id);
    });

    var values = await client.mGet(keys);

    (values || []).forEach(function (value, index) {
      var id = batch[index];

      if (!value) return;

      try {
        resolved.set(id, { id: JSON.parse(value).id });
      } catch (e) {
        // Unparseable - treated as missing, like a nil reply.
      }
    });

    // Yield so V8 can reclaim this batch's parsed JSON before the
    // next batch is fetched.
    await new Promise(function (resolve) {
      setImmediate(resolve);
    });
  }
}

module.exports = withCallback(async function main(blog) {
  const report = [];
  // id -> {id} for entries found, shared across every tag in this call.
  const resolved = new Map();
  // Stale ids whose full repair (rename + Entry.set) has already run this
  // call - see the mismatch branch below.
  const repaired = new Set();

  const tags = await Tags.list(blog.id);

  for (const tag of tags) {
    const result = await Tags.get(blog.id, tag.slug);

    const entryIDs = result.entryIDs;

    const tagKey = Tags.key.sortedTag(blog.id, tag.slug);

    if (!entryIDs.length) {
      report.push(["EMPTY TAG", tag]);
      const multi = client.multi();
      multi.sRem(Tags.key.all(blog.id), tag.slug);
      multi.del(tagKey);
      await execTransaction(multi);
      continue;
    }

    await resolveEntryIDs(blog.id, entryIDs, resolved);

    await eachLimit(entryIDs, 20, async function (entryID) {
      const meta = resolved.get(entryID);

      if (!meta) {
        report.push(["MISSING", entryID]);
        const multi = client.multi();
        multi.zRem(tagKey, entryID);
        return execTransaction(multi);
      }

      if (meta.id === entryID) return;

      if (repaired.has(entryID)) {
        // Already fully repaired via an earlier tag this run -
        // Entry.set's Tags.set call (triggered by that repair)
        // already re-added the real id to every tag in
        // entry.tags, including this one if it's still tagged
        // here. The reverse key (Tags.key.entry) was already
        // renamed away as part of that repair, so renaming it
        // again would fail with "no such key" - just drop the
        // stale id from this tag instead.
        report.push(["MISMATCH", entryID, meta.id]);
        const multi = client.multi();
        multi.zRem(tagKey, entryID);
        return execTransaction(multi);
      }

      // Rare - re-fetch the full entry (content included) only
      // for this mismatched id, so it can be re-saved as-is
      // under the correct key.
      // A failed read is the same as no entry
      let entry;

      try {
        entry = await Entry.get(blog.id, entryID);
      } catch (getErr) {
        entry = undefined;
      }

      if (!entry) {
        resolved.delete(entryID);
        report.push(["MISSING", entryID]);
        const multi = client.multi();
        multi.zRem(tagKey, entryID);
        return execTransaction(multi);
      }

      report.push(["MISMATCH", entryID, entry.id]);
      var multi = client.multi();
      var entryKeyForIncorrectID = Tags.key.entry(blog.id, entryID);
      var entryKeyForCorrectID = Tags.key.entry(blog.id, entry.id);
      var score = entry.dateStamp;
      if (typeof score !== "number" || isNaN(score)) {
        score = Date.now();
      }

      multi.rename(entryKeyForIncorrectID, entryKeyForCorrectID);
      multi.zRem(tagKey, entryID);
      multi.zAdd(tagKey, { score: score, value: entry.id });
      await execTransaction(multi);
      await Entry.set(blog.id, entry.id, entry);
      // Leave entryID resolved as a mismatch, and remember
      // it's been fully repaired, so another tag holding
      // the same stale id just drops it instead of
      // repeating the now-impossible rename.
      resolved.set(entry.id, { id: entry.id });
      repaired.add(entryID);
    });
  }

  return report;
});
