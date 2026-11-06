var ensure = require("helper/ensure");
var Entries = require("models/entries");
var eachBlog = require("./blog");
var progress = require("./progress");
var { promisify } = require("util");

// The promise core. doThis is (user, blog, entry) and may return a promise.
function eachEntry(doThis, options = {}) {
  return eachBlog.promise(async function (user, blog) {
    // Entries.each streams ids, so the per-blog total is not known up
    // front - the frame shows the running count as "(123/?)". Skipped
    // under options.p: parallel blogs would share one global frame stack.
    var bar = options.p ? null : progress.push("Entry", null);

    try {
      await new Promise((resolve, reject) => {
        Entries.each(
          blog.id,
          function (entry, nextEntry) {
            if (bar) bar.tick();
            Promise.resolve()
              .then(() => doThis(user, blog, entry))
              .then(
                () => nextEntry(),
                (err) => nextEntry(err)
              );
          },
          (err) => (err ? reject(err) : resolve())
        );
      });
    } finally {
      if (bar) bar.pop();
    }
  }, options);
}

// Callback API, for the scripts that still pass doThis(user, blog, entry, next).
module.exports = function (doThis, allDone, options) {
  options = options || {};

  ensure(doThis, "function").and(allDone, "function").and(options, "object");

  eachEntry(promisify(doThis), options).then(
    () => allDone(null),
    (err) => allDone(err)
  );
};

module.exports.promise = eachEntry;
