// Lists users whose Stripe subscription has collection paused (via
// scripts/user/pause-account.js or by hand on Stripe). These are the
// accounts models/user/removal excludes from the overdue/cancellation
// deletion checks.
//
// Usage: node scripts/user/list-paused-subscribers.js

var each = require("../each/user");
var Blog = require("models/blog");
var { promisify } = require("util");

var found = [];

async function main() {
  await promisify(each)(function (user, next) {
    if (!user.subscription || !user.subscription.pause_collection)
      return next();

    (async function () {
      var blogs = await Promise.all(
        (user.blogs || []).map(async function (blogID) {
          var blog = await Blog.get({ id: blogID });
          return blog ? blog.domain || blog.handle : blogID + " (missing)";
        })
      );

      found.push({
        email: user.email,
        uid: user.uid,
        status: user.subscription.status,
        resumesAt: user.subscription.pause_collection.resumes_at
          ? new Date(
              user.subscription.pause_collection.resumes_at * 1000
            ).toISOString()
          : "never",
        isDisabled: user.isDisabled,
        blogs: blogs.join(", ") || "none",
      });
    })().then(function () {
      next();
    }, next);
  });

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
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
