// I want to be able to get info about:

// Entry:
// - URL to entry, see its source file

// Blog:
// - URL to blog, see its owner, URL and access the dashboard
// - blog ID, see its owner, URL and access the dashboard

// User:
// - user ID, see its blogs, subscription info
// - email, see its blogs, subscription info

var User = require("models/user");
var getEntry = require("../get/entry");
var getBlog = require("../get/blog");
var config = require("config");
var colors = require("colors/safe");
var access = require("../blog/access");
var identifier = process.argv[2];
var moment = require("moment");
var prettyPrice = require("helper/prettyPrice");

if (!identifier) throw "Please pass an identifier for a user, blog or entry.";

function callback(err) {
  if (err) throw err;
  console.log("Done!");
  process.exit();
}

// Parse a URL to an entry
getEntry(identifier, function (err, user, blog, entry) {
  if (entry) {
    return showEntry(entry, blog, user, callback);
  }

  // Parse a URL to a blog
  getBlog(identifier, function (err, user, blog) {
    if (blog) {
      return showBlog(blog, user, callback);
    }

    User.getById(identifier, function (err, user) {
      if (user) {
        return showUser(user, callback);
      }

      User.getByEmail(identifier, function (err, user) {
        if (user) {
          return showUser(user, callback);
        }

        callback(
          new Error(
            'Could not find a matching entry, blog or user for "' +
              identifier +
              '"'
          )
        );
      });
    });
  });
});

function showEntry(entry, blog, user, callback) {
  var origin =
    "http" +
    (config.environment === "development" ? "" : "s") +
    "://" +
    blog.handle +
    "." +
    config.host;

  console.log();
  console.log(colors.dim("Found entry " + entry.id));
  console.log("- URL:", colors.green(origin + entry.url));
  console.log("- Source:", colors.yellow(origin + entry.path));
  console.log("- Full:", origin + entry.url + "?json=true");

  showBlog(blog, user, callback);
}

function showBlog(blog, user, callback) {
  var origin =
    "http" +
    (config.environment === "development" ? "" : "s") +
    "://" +
    blog.handle +
    "." +
    config.host;
  console.log();
  console.log(colors.dim("Found " + blog.id + " client=" + blog.client));
  console.log("Site:", colors.green(origin));
  showUser(user, callback);
}

function showUser(user, callback) {
  console.log();
  console.log(colors.dim("Found " + user.uid));
  console.log("Email: " + user.email);

  var subscriptionMessage;

  if (user.subscription.status) {
    subscriptionMessage = user.subscription.status + ", ";
  }

  if (user.subscription && user.subscription.plan) {
    subscriptionMessage =
      subscriptionMessage +
      user.subscription.quantity +
      " x " +
      prettyPrice(user.subscription.plan.amount) +
      "/" +
      user.subscription.plan.interval;
  }

  if (user.subscription.status) {
    var end = moment
      .utc(user.subscription.current_period_end * 1000)
      .format("LL");

    if (user.subscription.status !== "active") {
      subscriptionMessage = subscriptionMessage + ", ends " + end;
    } else {
      subscriptionMessage = subscriptionMessage + ", renewing " + end;
    }
  } else {
    subscriptionMessage = "no subscription";
  }

  console.log("Subscription: " + subscriptionMessage);
  console.log("Blogs: " + user.blogs);
  access(user.uid, function (err, url) {
    console.log("Dashboard:", colors.yellow(url));
    console.log();
    callback();
  });
}
