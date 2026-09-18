// Lists disabled users that delete-users-to-remove.js will never pick up
// through the cancellation path: they are disabled but have no cancelled
// Stripe/PayPal subscription (e.g. disabled by hand, or no subscription at
// all). Unpaid/past_due users are included with their overdue phase so you can
// see whether the overdue flow will eventually handle them.
//
// Usage: node scripts/user/identify-disabled-users-to-review.js

const each = require("../each/user");
const Blog = require("models/blog");
const async = require("async");
const subscriptionLifecycle = require("models/user/subscriptionLifecycle");

const found = [];

each(
  function (user, next) {
    if (!user.isDisabled) return next();

    if (subscriptionLifecycle.cancellationDetails(user).cancelled) return next();

    const overdue = subscriptionLifecycle.overdueDetails(user);

    async.map(
      user.blogs || [],
      function (blogID, done) {
        Blog.get({ id: blogID }, function (err, blog) {
          done(null, blog ? blog.domain || blog.handle : blogID + " (missing)");
        });
      },
      function (err, blogs) {
        found.push({
          email: user.email,
          uid: user.uid,
          stripe: (user.subscription && user.subscription.status) || "none",
          paypal: (user.paypal && user.paypal.status) || "none",
          overdue: overdue.overdue ? overdue.phase : "no",
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
          "stripe=" + u.stripe,
          "paypal=" + u.paypal,
          "overdue=" + u.overdue,
          "blogs=" + u.blogs,
        ].join(" | ")
      );
    });

    console.log("Done. Users to review:", found.length);
    process.exit();
  }
);
