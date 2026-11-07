var config = require("config");
var Delete = require("dashboard/account/delete");
var get = require("../get/user");
var getConfirmation = require("../util/getConfirmation");
var colors = require("colors");
var Blog = require("models/blog");
var each = require("../each/user");
var moment = require("moment");

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

async function getUser(identifier) {
  const { user } = await get(identifier);
  return user;
}

// Runs one of the Delete steps and records its outcome, so the next step
// still runs when this one fails (what async.reflect did).
function reflectStep(step, req, res) {
  return new Promise(function (resolve) {
    step(req, res, function (err) {
      if (err) return resolve({ error: err });
      resolve({ value: undefined });
    });
  });
}

async function main(user) {
  var blogs = await Promise.all(
    (user.blogs || []).map(function (blogID) {
      return Blog.get({ id: blogID });
    })
  );

  var message = [
    "Do you want to delete account " + colors.red(user.email) + "?",
  ];

  if (user.isDisabled) {
    message.push("- " + colors.green("User is disabled"));
  } else {
    message.push("- " + colors.red("User is not disabled"));
  }

  if (user.subscription) {
    message.push(
      "- Will delete Stripe customer " +
        colors.red(user.subscription.customer) +
        " and cancel subscription"
    );
  } else {
    message.push("- No Stripe subscription to remove");
  }

  if (blogs.length) {
    blogs.forEach(function (blog) {
      message.push(
        "- Will delete blog " +
          colors.red(blog.title) +
          " " +
          colors.dim(blog.id) +
          " updated " +
          colors.underline(moment(blog.cacheID).fromNow()) +
          " - http://" +
          blog.handle +
          "." +
          config.host +
          " " +
          blog.domain
      );
    });
  } else {
    message.push("- No blogs to delete");
  }

  var yes = await getConfirmation(message.join("\n"));

  if (!yes) {
    console.log("\nDid not delete " + user.email);
    return;
  }

  var req = { user: user, blogs: blogs };
  var res = {};

  var results = [];

  for (const step of [
    Delete.exports.subscription,
    Delete.exports.blogs,
    Delete.exports.user,
  ]) {
    results.push(await reflectStep(step, req, res));
  }

  console.log();

  if (results[0].error) {
    console.log(colors.red("Error deleting blogs: " + results[0].error));
  } else {
    console.log(colors.green("Deleted all the user's blogs!"));
  }

  if (results[1].error) {
    console.log(colors.red("Error deleting subscription: " + results[1].error));
  } else {
    console.log(colors.green("Deleted subscription!"));
  }

  if (results[2].error) {
    console.log(colors.red("Error deleting user: " + results[2].error));
  } else {
    console.log(colors.green("Deleted user!"));
  }

  if (
    results.slice(2).filter(function (i) {
      return !!i.error;
    }).length
  ) {
    throw new Error("Unhandled error in results " + results);
  }
}

async function run() {
  if (!process.argv[2]) {
    console.log("Searching for disabled users to delete");

    await forEachUser(async function (user) {
      if (!user.isDisabled) return;

      await main(user);
    });

    console.log("Search complete!");
    process.exit();
  } else {
    var user = await getUser(process.argv[2]);
    await main(user);
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
