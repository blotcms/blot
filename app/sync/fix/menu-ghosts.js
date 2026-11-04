const Entry = require("models/entry");
const Blog = require("models/blog");
const async = require("async");
const _ = require("lodash");

function main(blog, callback) {
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
  const fixes = {};

  async.map(
    blog.menu,
    function (item, next) {
      Entry.get(blog.id, item.id, function (entry) {
        if (entry && entry.deleted) {
          report.push(["Delete", item]);
          removeIDs.add(item.id);
          changed = true;
          next(null, null);
        } else if (entry && existing[entry.id] === true) {
          report.push(["Delete duplicate", item]);
          changed = true;
          next(null, null);
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
          liveIDs.add(item.id);
          fixes[item.id] = {
            label: item.label,
            metadata: item.metadata,
            url: item.url,
          };
          next(null, item);
        } else {
          next(null, item);
        }
      });
    },
    function (err) {
      if (err) return callback(err);

      if (!changed) return callback(null, report);

      // Fix() runs outside the folder lock, so a sync may have changed the
      // menu since blog.menu was read. Writing our whole array back would
      // undo that change. Re-read the menu now and apply only our own
      // corrections, by item id, to what is there, which narrows the window
      // to the gap between this read and Blog.set.
      Blog.get({ id: blog.id }, function (err, latest) {
        if (err) return callback(err);
        if (!latest) return callback(null, report);

        const seen = {};
        const menu = [];

        (latest.menu || []).forEach(function (item) {
          if (removeIDs.has(item.id)) return;

          if (liveIDs.has(item.id)) {
            if (seen[item.id]) return;
            seen[item.id] = true;
            item = Object.assign({}, item, fixes[item.id]);
          }

          menu.push(item);
        });

        if (_.isEqual(menu, latest.menu || [])) return callback(null, report);

        Blog.set(blog.id, { menu: menu }, function (err) {
          if (err) return callback(err);
          callback(null, report);
        });
      });
    },
  );
}

module.exports = main;
