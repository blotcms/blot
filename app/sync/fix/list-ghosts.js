const Entry = require("models/entry");
const Entries = require("models/entries");
const client = require("models/client");
const entryKey = require("models/entry/key").entry;
const { promisify } = require("util");

var lists = ["all", "created", "entries", "drafts", "scheduled", "pages"];

// Entries are read in full (content included) - for a blog with large
// posts that can be many MB per entry. The same id often appears in
// several of the lists above (eg. "all" and "pages"), so checking each
// list independently used to re-fetch that same full entry once per list
// it belonged to. Fetching each unique id once, in batched MGETs (index
// aligned with the batch - unlike Entry.get, which filters out missing
// entries) rather than one GET per id, and yielding to the event loop
// between batches so V8 can reclaim the large strings already checked,
// keeps peak memory proportional to BATCH_SIZE rather than to the whole
// blog. Each MGET reply holds whole entries and shares a connection with the
// lock heartbeat, so batches stay small.
var BATCH_SIZE = 20;

async function pruneMissing(blogID) {
  var removed = await promisify(Entries.pruneMissing.bind(Entries))(blogID);
  return removed || {};
}

function deleteEntryKey(blogID, id) {
  return client.del(entryKey(blogID, id));
}

function getEntry(blogID, id) {
  return promisify((next) => Entry.get(blogID, id, (entry) => next(null, entry)))();
}

function setEntry(blogID, id, entry) {
  return promisify(Entry.set.bind(Entry))(blogID, id, entry);
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function resolveIDs(blogID, ids) {
  const resolved = new Map();

  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const keys = batch.map((id) => entryKey(blogID, id));
    const values = await client.mGet(keys);

    (values || []).forEach((value, index) => {
      const id = batch[index];

      if (!value) {
        resolved.set(id, null);
        return;
      }

      try {
        resolved.set(id, { id: JSON.parse(value).id });
      } catch (e) {
        resolved.set(id, null);
      }
    });

    await yieldToEventLoop();
  }

  return resolved;
}

function main(blog, callback) {
  const report = [];

  (async function () {
    const prunedByList = await pruneMissing(blog.id);

    // pruneMissing (models/entries) removes list members that have no
    // backing entry key at all, before the mismatch-detection loop below
    // ever sees them - report them here (matching the [list, reason, id]
    // shape the mismatch loop uses) so Fix() bumps cacheID for this too.
    for (const listName in prunedByList) {
      for (const id of prunedByList[listName]) {
        report.push([listName, "MISSING", id]);
      }
    }

    const idsByList = {};
    const uniqueIds = new Set();

    for (const list of lists) {
      const key = "blog:" + blog.id + ":" + list;
      const ids = await client.zRange(key, 0, -1, { REV: true });
      idsByList[list] = ids;
      for (const id of ids) uniqueIds.add(id);
    }

    const allIds = [...uniqueIds];
    const ghostIds = new Set();

    const resolved = await resolveIDs(blog.id, allIds);

    for (const id of allIds) {
      const meta = resolved.get(id);

      if (meta && meta.id === id) continue;

      ghostIds.add(id);

      if (!meta) continue;

      // Mismatch - re-fetch the full entry (content included) only for
      // this id so it can be re-saved under the corrected key.
      const entry = await getEntry(blog.id, id);
      if (entry) {
        // The raw key at the stale id is about to become an orphan (the
        // entry is re-saved below under its real id, entry.id). Delete it
        // first rather than after: models/entry/_setUrl.js's url-claim
        // check (models/entry/key.js's url index) would otherwise still
        // find this orphan, see it as a live entry still using the
        // original url, and force the real entry onto a different
        // (deduped) url - which then stops menu-ghosts/_assign.js's
        // addToMenu from matching it to the existing menu item by url, so
        // a second menu item gets added instead of the stale one being
        // updated in place. Deleting it first lets the real entry reclaim
        // its original url and the menu item update cleanly. Only the raw
        // entry key is removed here - never Entry.drop, which would also
        // touch lists/tags/menu for the *real* entry we're about to save.
        //
        // Keep the raw value around in case setEntry fails (validation,
        // blog lookup, Redis error, etc.) after the stale key is gone -
        // without it that failure would leave no stored copy of the entry
        // at all. Restore it under the stale key before propagating the
        // error.
        const staleKey = entryKey(blog.id, id);
        const staleRaw = await client.get(staleKey);
        await deleteEntryKey(blog.id, id);
        try {
          await setEntry(blog.id, entry.id, entry);
        } catch (err) {
          if (staleRaw) await client.set(staleKey, staleRaw);
          throw err;
        }
      }
    }

    for (const list of lists) {
      const key = "blog:" + blog.id + ":" + list;

      for (const id of idsByList[list]) {
        if (!ghostIds.has(id)) continue;

        report.push([list, "MISMATCH", id]);
        await client.zRem(key, id);
      }
    }

    callback(null, report);
  })().catch(callback);
}

module.exports = main;
