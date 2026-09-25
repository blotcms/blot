// Lists users whose Stripe subscription has collection paused (via
// scripts/user/pause-account.js or by hand on Stripe). These are the
// accounts models/user/removal excludes from the overdue/cancellation
// deletion checks.
//
// Usage: node scripts/user/list-paused-subscribers.js

var each = require("../each/user");
var Blog = require("models/blog");
var async = require("async");

var found = [];

each(
  function (user, next) {
    if (!user.subscription || !user.subscription.pause_collection) return next();

    async.map(
      user.blogs || [],
      function (blogID, done) {
        Blog.get({ id: blogID }, function (err, blog) {
          if (err) return done(err);
          done(null, blog ? blog.domain || blog.handle : blogID + " (missing)");
        });
      },
      function (err, blogs) {
        if (err) return next(err);

        found.push({
          email: user.email,
          uid: user.uid,
          status: user.subscription.status,
          resumesAt: user.subscription.pause_collection.resumes_at
            ? new Date(user.subscription.pause_collection.resumes_at * 1000).toISOString()
            : "never",
          isDisabled: user.isDisabled,
          blogs: blogs.join(", ") || "none",
        });
        next();
      }
    );
  },
  function (err) {
    if (err) throw err;

    found.forEach(function (u) {
      console.log(
        [
          u.email,
          u.uid,
          "status=" + u.status,
          "resumesAt=" + u.resumesAt,
          "isDisabled=" + u.isDisabled,
          "blogs=" + u.blogs,
        ].join(" | ")
      );
    });

    console.log("Done. Paused subscribers:", found.length);
    process.exit();
  }
);
