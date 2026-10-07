const Entries = require("models/entries");
const Entry = require("models/entry");
const Blog = require("models/blog");
const async = require("async");

function publishScheduledEntries (callback = function () {}) {
  Blog.getAllIDs(function (err, blogIDs) {
    if (err) return callback(err);
    async.each(
      blogIDs,
      function (blogID, nextBlog) {
        Entries.get(blogID, { lists: ["scheduled"] }, function (err, list) {
          // Through async.each, so the caller hears about a failure once
          if (err) return nextBlog(err);
          async.each(
            list.scheduled,
            function (futureEntry, nextEntry) {
              // Saving an update, even an empty one, will ensure the entry model
              // schedules a task to rebuild the entry again in future when it's
              // time to publish the entry.
              Entry.set(blogID, futureEntry.path, {}, nextEntry);
            },
            nextBlog
          );
        });
      },
      callback
    );
  });
}
module.exports = publishScheduledEntries;
