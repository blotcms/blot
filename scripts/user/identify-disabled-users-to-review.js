// Lists disabled users that delete-users-to-remove.js will never pick up
// through the cancellation path: they are disabled but have no cancelled
// Stripe/PayPal subscription (e.g. disabled by hand, or no subscription at
// all). Unpaid/past_due users are included with their overdue phase so you can
// see whether the overdue flow will eventually handle them.
//
// Usage: node scripts/user/identify-disabled-users-to-review.js

const each = require("../each/user");
const Blog = require("models/blog");
const subscriptionLifecycle = require("models/user/subscriptionLifecycle");

const found = [];

// scripts/each/user is callback-based and stops at the first error. Runs fn
// for each user in turn, and passes a rejection from fn on as the error.
function forEachUser(fn) {
  return new Promise(function (resolve, reject) {
    each(
      function (user, next) {
        Promise.resolve()
          .then(function () {
            return fn(user);
          })
          .then(
            function () {
              next();
            },
            function (err) {
              next(err);
            }
          );
      },
      function (err) {
        if (err) return reject(err);
        resolve();
      }
    );
  });
}

async function run() {
  await forEachUser(async function (user) {
    if (!user.isDisabled) return;

    if (subscriptionLifecycle.cancellationDetails(user).cancelled) return;

    const overdue = subscriptionLifecycle.overdueDetails(user);

    const blogs = await Promise.all(
      (user.blogs || []).map(async function (blogID) {
        let blog;

        try {
          blog = await Blog.get({ id: blogID });
        } catch (err) {
          // The lookup error was ignored before, so the blog shows as missing
          blog = undefined;
        }

        return blog ? blog.domain || blog.handle : blogID + " (missing)";
      })
    );

    found.push({
      email: user.email,
      uid: user.uid,
      stripe: (user.subscription && user.subscription.status) || "none",
      paypal: (user.paypal && user.paypal.status) || "none",
      overdue: overdue.overdue ? overdue.phase : "no",
      blogs: blogs.join(", ") || "none",
    });
  });

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

run().then(
  function () {
    process.exit(0);
  },
  function (err) {
    console.error(err);
    process.exit(1);
  }
);
