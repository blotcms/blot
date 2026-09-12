const type = require("helper/type");
const Entry = require("models/entry/instance");
const list = require("./list");

module.exports = async function eachEntry(locals, iterator) {
  const entries = [];

  extractEntriesFromView(locals);

  await Promise.all(
    entries.map(async (entry) => {
      const queue = [iterator(entry)];

      if (entry.next instanceof Entry) queue.push(iterator(entry.next));
      if (entry.previous instanceof Entry) queue.push(iterator(entry.previous));

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
        entries.push(local);
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
          entries.push(entry);
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
