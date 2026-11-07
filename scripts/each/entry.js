var Entries = require("models/entries");
var eachBlog = require("./blog");
var progress = require("./progress");

// Calls doThis(user, blog, entry) for every entry of every blog. doThis may
// be async; a rejection stops the run.
function eachEntry(doThis, options = {}) {
  return eachBlog(async function (user, blog) {
    // Entries.each streams ids, so the per-blog total is not known up
    // front - the frame shows the running count as "(123/?)". Skipped
    // under options.p: parallel blogs would share one global frame stack.
    var bar = options.p ? null : progress.push("Entry", null);

    try {
      await Entries.each(blog.id, async function (entry) {
        if (bar) bar.tick();
        await doThis(user, blog, entry);
      });
    } finally {
      if (bar) bar.pop();
    }
  }, options);
}

module.exports = eachEntry;
module.exports.promise = eachEntry;
