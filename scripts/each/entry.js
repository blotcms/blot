var ensure = require("helper/ensure");
var Entries = require("models/entries");
var eachBlog = require("./blog");
var progress = require("./progress");

module.exports = function (doThis, allDone, options) {
  options = options || {};

  ensure(doThis, "function").and(allDone, "function").and(options, "object");

  eachBlog(
    function (user, blog, nextBlog) {
      // Entries.each streams ids, so the per-blog total is not known up
      // front - the frame shows the running count as "(123/?)". Skipped
      // under options.p: parallel blogs would share one global frame stack.
      var bar = options.p ? null : progress.push("Entry", null);

      Entries.each(
        blog.id,
        function (entry, nextEntry) {
          if (bar) bar.tick();
          doThis(user, blog, entry, nextEntry);
        },
        function (err) {
          if (bar) bar.pop();
          nextBlog(err);
        }
      );
    },
    allDone,
    options
  );
};
