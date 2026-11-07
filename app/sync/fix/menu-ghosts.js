const promiseOnly = require("helper/promiseOnly");
const Entry = require("models/entry");
const Blog = require("models/blog");
const _ = require("lodash");

async function main(blog) {
  const existing = {};
  const report = [];
  // item is mutated in place below, and it's the same object living inside
  // blog.menu - so comparing the final array against blog.menu can never
  // detect a label/metadata/url correction (only removals, which change the
  // array itself). Track explicitly whether anything changed instead.
  let changed = false;
  // What to do to each menu item id, recorded as we go so it can be applied to
  // a freshly read menu (see below) rather than to the one we started with.
  const removeIDs = new Set();
  const liveIDs = new Set();
  // Raw ids reported as duplicates of an item with a different raw id (ids
  // that Entry.get normalizes to the same entry, e.g. NFC and NFD).
  const duplicateOf = new Map();
  const keptIDs = {};
  const fixes = {};

  // All the menu items are looked up at once, as async.map did, and each is
  // handled as its read comes back: which of two duplicates is kept depends
  // on that order.
  await Promise.all(
    (blog.menu || []).map(async function (item) {
      // A failed read is the same as no entry
      const entry = await Entry.get(blog.id, item.id).catch(() => undefined);

      if (entry && entry.deleted) {
        report.push(["Delete", item]);
        removeIDs.add(item.id);
        changed = true;
      } else if (entry && existing[entry.id] === true) {
        report.push(["Delete duplicate", item]);
        if (item.id !== keptIDs[entry.id])
          duplicateOf.set(item.id, keptIDs[entry.id]);
        changed = true;
      } else if (entry) {
        if (item.label !== entry.title) {
          item.label = entry.title;
          report.push(["Changed label of", item]);
          changed = true;
        }

        if (!_.isEqual(item.metadata, entry.metadata)) {
          item.metadata = entry.metadata;
          report.push(["Changed metadata of", item]);
          changed = true;
        }

        if (item.url !== entry.url) {
          item.url = entry.url;
          report.push(["Changed URL of", item]);
          changed = true;
        }

        existing[entry.id] = true;
        keptIDs[entry.id] = item.id;
        liveIDs.add(item.id);
        fixes[item.id] = {
          label: item.label,
          metadata: item.metadata,
          url: item.url,
        };
      }
    })
  );

  if (!changed) return report;

  // Fix() runs outside the folder lock, so a sync may have changed the
  // menu since blog.menu was read. Writing our whole array back would
  // undo that change. Re-read the menu now and apply only our own
  // corrections, by item id, to what is there, which narrows the window
  // to the gap between this read and Blog.set.
  const latest = await Blog.get({ id: blog.id });

  if (!latest) return report;

  const seen = {};
  const present = new Set(
    (latest.menu || [])
      .map(function (item) {
        return item.id;
      })
      .filter(function (id) {
        return !removeIDs.has(id);
      })
  );
  const menu = [];

  (latest.menu || []).forEach(function (item) {
    if (removeIDs.has(item.id)) return;

    // Only drop a duplicate while the item it duplicates is still
    // there, otherwise it is the menu's only link to the entry.
    if (duplicateOf.has(item.id) && present.has(duplicateOf.get(item.id)))
      return;

    if (liveIDs.has(item.id)) {
      if (seen[item.id]) return;
      seen[item.id] = true;
      item = Object.assign({}, item, fixes[item.id]);
    }

    menu.push(item);
  });

  if (_.isEqual(menu, latest.menu || [])) return report;

  await Blog.set(blog.id, { menu: menu });

  return report;
}

module.exports = promiseOnly(main);
