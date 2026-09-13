const Entry = require("models/entry");
const Entries = require("models/entries");
const client = require("models/client");
const { promisify } = require("util");

var lists = ["all", "created", "entries", "drafts", "scheduled", "pages"];

// Entries are read in full (content included) - for a blog with large
// posts that can be many MB per entry. The same id often appears in
// several of the lists above (eg. "all" and "pages"), so checking each
// list independently used to re-fetch that same full entry once per list
// it belonged to. Fetching each id once and processing ids in bounded
// batches - yielding to the event loop between batches so V8 can reclaim
// the large strings already checked - keeps peak memory proportional to
// BATCH_SIZE rather than to the whole blog.
var BATCH_SIZE = 100;

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

    for (let i = 0; i < allIds.length; i += BATCH_SIZE) {
      const batch = allIds.slice(i, i + BATCH_SIZE);

      for (const id of batch) {
        const entry = await getEntry(blog.id, id);

        if (entry && entry.id === id) continue;

        ghostIds.add(id);
        if (entry) await setEntry(blog.id, entry.id, entry);
      }

      await yieldToEventLoop();
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
