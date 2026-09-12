// Builds the precomputed archives index (app/models/archives) for every
// existing blog in one pass, rather than waiting for each blog's next sync
// to trigger app/sync/fix/archives-index.js. Safe to run repeatedly and
// while the app is live: rebuild() replaces a blog's index atomically.
//
//   node scripts/archives/backfill.js            # every blog
//   node scripts/archives/backfill.js -o BLOGID  # one blog
//   node scripts/archives/backfill.js -s 500     # resume from blog #500
//
// (-o / -s / -e / -r / -p / -c are handled by scripts/each/blog.js.)

var eachBlog = require("../each/blog");
var Archives = require("models/archives");
var options = require("minimist")(process.argv.slice(2));

var totals = {
  blogs: 0,
  entries: 0,
  errors: 0,
};

function backfillBlog(user, blog, nextBlog) {
  totals.blogs++;

  Archives.rebuild(blog.id, function (err, entryCount) {
    if (err) {
      totals.errors++;
      console.error(blog.id, "rebuild failed:", err.message || err);
      return nextBlog();
    }

    totals.entries += entryCount;

    if (totals.blogs % 1000 === 0) {
      console.log("... rebuilt archives index for", totals.blogs, "blogs");
    }

    nextBlog();
  });
}

eachBlog(
  backfillBlog,
  function () {
    console.log("Archives backfill finished:");
    console.log(JSON.stringify(totals, null, 2));
    process.exit(totals.errors ? 1 : 0);
  },
  options
);
