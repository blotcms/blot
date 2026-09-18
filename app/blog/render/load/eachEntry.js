const type = require("helper/type");
const Entry = require("models/entry/instance");
const list = require("./list");

module.exports = async function eachEntry(locals, iterator) {
  const entries = [];
  // Older listing templates get the same Entry objects aliased under two
  // locals keys (e.g. `posts` and `entries` - see render/listingViews.js), so
  // this walk can reach the same object more than once. Dedupe by identity;
  // otherwise augment() runs twice on one entry and mangles fields it
  // rewrites in place, e.g. entry.tags (strings -> objects, then discarded
  // as invalid on the second pass).
  const seen = new Set();

  function queueEntry(entry) {
    if (seen.has(entry)) return;
    seen.add(entry);
    entries.push(entry);
  }

  extractEntriesFromView(locals);

  await Promise.all(
    entries.map(async (entry) => {
      const queue = [iterator(entry)];

      if (entry.next instanceof Entry && !seen.has(entry.next)) {
        seen.add(entry.next);
        queue.push(iterator(entry.next));
      }
      if (entry.previous instanceof Entry && !seen.has(entry.previous)) {
        seen.add(entry.previous);
        queue.push(iterator(entry.previous));
      }

      await Promise.all(queue);
    })
  );

  function extractEntriesFromView(obj, depth = 0) {
    for (const key in obj) {
      const local = obj[key];

      // Partials never contain an entry
      if (key === "partials" && depth === 0) {
        continue;
      }

      // This is an entry, modify it now and proceed!
      if (local instanceof Entry) {
        queueEntry(local);
        continue;
      }

      // This is a list (not neccessarily of entries)
      // so add the needed properties to it, e.g. 'first'.
      if (type(local, "array")) {
        list(local);
      }

      // This is a list of entries so modify each and proceed
      // We assume that if the first item in the list is an
      // entry then the rest is too. This could be dumb.
      if (type(local, "array") && local[0] instanceof Entry) {
        for (const entry of local) {
          queueEntry(entry);
        }
        continue;
      }

      // Proceed down the tree!
      if (type(local, "object") || type(local, "array")) {
        extractEntriesFromView(local, depth + 1);
      }
    }
  }
};
