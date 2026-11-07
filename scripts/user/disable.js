var User = require("models/user");
var Blog = require("models/blog");
var get = require("../get/user");
var each = require("../each/user");
var config = require("config");
var stripe = require("stripe")(config.stripe.secret);
var getConfirmation = require("../util/getConfirmation");
var moment = require("moment");
var colors = require("colors/safe");

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

function getUser(identifier) {
  return new Promise(function (resolve, reject) {
    get(identifier, function (err, user) {
      if (err) return reject(err);
      resolve(user);
    });
  });
}

async function main(user) {
  var message = [""];

  if (user.subscription && user.subscription.current_period_end) {
    var ed =
      user.subscription.current_period_end * 1000 > Date.now() ? "s " : "ed ";
    message.push(
      "User " +
        colors.yellow(user.email) +
        " " +
        colors.dim(user.uid) +
        " has an " +
        user.subscription.status +
        " " +
        user.subscription.plan.interval +
        "ly subscription which end" +
        ed +
        colors.underline(
          moment(user.subscription.current_period_end * 1000).fromNow()
        )
    );
  } else {
    message.push(
      "User " +
        colors.yellow(user.email) +
        " " +
        colors.dim(user.uid) +
        " does not have a subscription"
    );
  }

  var blogs = await Promise.all(
    (user.blogs || []).map(async function (blogID) {
      try {
        return await Blog.get({ id: blogID });
      } catch (err) {
        // The lookup error was ignored before, so the blog shows as missing
        return undefined;
      }
    })
  );

  blogs.forEach(function (blog) {
    if (!blog) {
      message.push(colors.red("Warning no blog with ID " + user.blogs));
      return;
    }

    message.push(
      "Blog " +
        colors.yellow(blog.title) +
        " " +
        colors.dim(blog.id) +
        " was updated " +
        colors.underline(moment(blog.cacheID).fromNow()) +
        " - https://" +
        blog.handle +
        "." +
        config.host +
        " " +
        blog.domain
    );
  });
  message.push(
    "Are you sure you want to disable " + colors.yellow(user.email) + "? (y/n)"
  );

  var ok = await getConfirmation(message.join("\n"));

  if (!ok) {
    console.log(colors.red("Did not disable " + user.email));
    return;
  }

  await User.disable(user);

  console.log(colors.green("Disabled " + user.email));
}

async function run() {
  if (process.argv[2]) {
    var user = await getUser(process.argv[2]);
    await main(user);
    process.exit();
  } else {
    console.log("Searching for users to disable");

    await forEachUser(async function (user) {
      if (user.isDisabled) return;

      // If the user doesn't have a Stripe subscription
      // they were probably an early user – don't disable
      if (
        !user.subscription ||
        !user.subscription.status ||
        !user.subscription.id
      ) {
        return;
      }

      // If the user's subscription period isn't over don't disable
      if (
        user.subscription &&
        user.subscription.current_period_end > Date.now() / 1000
      ) {
        return;
      }

      var subscription;

      try {
        subscription = await stripe.customers.retrieveSubscription(
          user.subscription.customer,
          user.subscription.id
        );
      } catch (err) {
        if (err.code === "resource_missing" && err.param === "id") {
          console.log(
            "used to have a Stripe subscription but no longer does, customer does not exist on Stripe"
          );
          return await main(user);
        }

        if (err.code === "resource_missing" && err.param === "subscription") {
          // we should list any subscriptions this user has to make sure
          console.log(
            'used to have a Stripe subscription but no longer does, customer still exists on Stripe"'
          );
          return await main(user);
        }

        throw err;
      }

      if (
        subscription.current_period_end < Date.now() / 1000 &&
        subscription.status !== "active"
      ) {
        console.log("has an overdue stripe subscription");
        return await main(user);
      }
    });

    console.log("Search complete!");
    process.exit();
  }
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
