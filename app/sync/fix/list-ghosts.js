const Entry = require("models/entry");
const Entries = require("models/entries");
const client = require("models/client");
const { promisify } = require("util");
const createEntryCache = require("./entry-cache");

var lists = ["all", "created", "entries", "drafts", "scheduled", "pages"];

function pruneMissing(blogID) {
  return promisify(Entries.pruneMissing.bind(Entries))(blogID);
}

function getManyFromCache(cache, ids) {
  return promisify(cache.getMany.bind(cache))(ids);
}

function getEntry(blogID, id) {
  return promisify((next) => Entry.get(blogID, id, (entry) => next(null, entry)))();
}

function setEntry(blogID, id, entry) {
  return promisify(Entry.set.bind(Entry))(blogID, id, entry);
}

function main(blog, cache, callback) {
  if (typeof cache === "function") {
    callback = cache;
    cache = createEntryCache(blog.id);
  }

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

    // The same id is often a member of several of the lists above (eg.
    // "all" and "pages"), and may already have been resolved by an earlier
    // check this Fix() run. Going through the shared cache means each id is
    // fetched from Redis at most once here, in bounded batches, rather than
    // once per list it belongs to.
    const resolved = await getManyFromCache(cache, allIds);

    for (const id of allIds) {
      const meta = resolved.get(id);

      if (meta && meta.id === id) continue;

      ghostIds.add(id);

      if (!meta) continue;

      // Mismatch - re-fetch the full entry (content included) only for
      // this id so it can be re-saved under the corrected key.
      const entry = await getEntry(blog.id, id);
      if (entry) {
        await setEntry(blog.id, entry.id, entry);
        cache.invalidate(id);
        cache.invalidate(entry.id);
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
