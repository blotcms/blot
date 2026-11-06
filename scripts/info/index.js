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

// Lookup errors have always counted as "no match" here, so they are ignored
async function ignoreErrors(lookup) {
  try {
    return await lookup();
  } catch (err) {
    return undefined;
  }
}

// Resolves { user, blog, entry }, all undefined when nothing matched
function lookupEntry(identifier) {
  return new Promise((resolve) =>
    getEntry(identifier, (err, user, blog, entry) =>
      resolve({ user, blog, entry })
    )
  );
}

// Resolves { user, blog }, both undefined when nothing matched
function lookupBlog(identifier) {
  return new Promise((resolve) =>
    getBlog(identifier, (err, user, blog) => resolve({ user, blog }))
  );
}

async function main() {
  // Parse a URL to an entry
  const byEntry = await lookupEntry(identifier);
  if (byEntry.entry) {
    return showEntry(byEntry.entry, byEntry.blog, byEntry.user);
  }

  // Parse a URL to a blog
  const byBlog = await lookupBlog(identifier);
  if (byBlog.blog) {
    return showBlog(byBlog.blog, byBlog.user);
  }

  const userByID = await ignoreErrors(() => User.getById(identifier));
  if (userByID) return showUser(userByID);

  const userByEmail = await ignoreErrors(() => User.getByEmail(identifier));
  if (userByEmail) return showUser(userByEmail);

  throw new Error(
    'Could not find a matching entry, blog or user for "' + identifier + '"'
  );
}

main().then(
  () => {
    console.log("Done!");
    process.exit();
  },
  (err) => {
    console.error(err);
    process.exit(1);
  }
);

function showEntry(entry, blog, user) {
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

  return showBlog(blog, user);
}

function showBlog(blog, user) {
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
  return showUser(user);
}

async function showUser(user) {
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
  // An error from access was never checked here, so the url is just undefined
  const url = await new Promise((resolve) =>
    access(user.uid, (err, url) => resolve(url))
  );
  console.log("Dashboard:", colors.yellow(url));
  console.log();
}
