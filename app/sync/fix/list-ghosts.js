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

function pruneMissing(blogID) {
  return promisify(Entries.pruneMissing.bind(Entries))(blogID);
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
    await pruneMissing(blog.id);

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
      if (entry) await setEntry(blog.id, entry.id, entry);
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
