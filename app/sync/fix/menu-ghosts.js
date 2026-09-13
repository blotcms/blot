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

  async.map(
    blog.menu,
    function (item, next) {
      Entry.get(blog.id, item.id, function (entry) {
        if (entry && entry.deleted) {
          report.push(["Delete", item]);
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
          next(null, item);
        } else {
          next(null, item);
        }
      });
    },
    function (err, results) {
      if (err) return callback(err);

      results = results.filter(function (item) {
        return item !== null;
      });

      if (!changed) {
        callback(null, report);
      } else {
        Blog.set(blog.id, { menu: results }, function (err) {
          if (err) return callback(err);
          callback(null, report);
        });
      }
    }
  );
}

module.exports = main;
