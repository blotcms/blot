var async = require("async");
var colors = require("colors/safe");
var moment = require("moment");
var eachUser = require("../each/user");
var getConfirmation = require("../util/getConfirmation");
var subscriptionLifecycle = require("models/user/subscriptionLifecycle");
var Delete = require("dashboard/account/delete");
var Blog = require("models/blog");

var argv = process.argv.slice(2);
var FAST_MODE = argv.indexOf("-fast") !== -1 || argv.indexOf("--fast") !== -1;
var HELP_FLAG = argv.indexOf("-h") !== -1 || argv.indexOf("--help") !== -1;
var FAST_CONFIRMATION_PROMPT = "Delete all <count> users? (y/n)";

function printUsage() {
  console.log("Usage: node scripts/user/delete-users-to-remove.js [-fast]");
  console.log("");
  console.log("Finds cancelled and overdue accounts that have passed their");
  console.log("grace period and are due for removal.");
  console.log("");
  console.log("Options:");
  console.log("  -fast, --fast  list all candidates first and confirm once before deleting");
  console.log("  -h, --help     show this help output");
}

if (HELP_FLAG) {
  printUsage();
  process.exit(0);
}

function candidateFromCancellation(user) {
  var details = subscriptionLifecycle.cancellationDetails(user);

  if (!details.cancelled || !details.periodEnded) return null;
  if (!subscriptionLifecycle.deletionDue(user)) return null;

  return {
    user: user,
    reason: "cancelled",
    description:
      "cancelled, subscription period ended " +
      moment(details.periodEndedAt).fromNow() +
      " (" +
      new Date(details.periodEndedAt).toISOString() +
      "), provider=" +
      details.provider,
  };
}

function candidateFromOverdue(user) {
  var overdue = subscriptionLifecycle.overdueDetails(user);

  if (!overdue.overdue || overdue.phase !== "deletion_flow") return null;

  return {
    user: user,
    reason: "overdue",
    description:
      "overdue since " +
      moment(overdue.startedAt).fromNow() +
      " (" +
      new Date(overdue.startedAt).toISOString() +
      ")",
  };
}

function describeUser(candidate, blogs) {
  var lines = [];

  lines.push(
    "Delete " +
      candidate.reason +
      " account " +
      colors.yellow(candidate.user.email) +
      " " +
      colors.dim(candidate.user.uid) +
      "?"
  );

  lines.push("- " + candidate.description);

  blogs.forEach(function (blog) {
    if (!blog) return;
    lines.push(
      "- blog: " +
        colors.yellow(blog.title) +
        " " +
        colors.dim(blog.id) +
        " " +
        (blog.domain || blog.handle)
    );
  });

  return lines.join("\n");
}

function describeCandidateSummary(candidate) {
  return [
    colors.yellow(candidate.user.email),
    colors.dim(candidate.user.uid),
    "reason=" + candidate.reason,
    candidate.description,
  ].join(" | ");
}

function deleteAccount(user, callback) {
  var req = { user: user };
  var res = {};

  async.applyEachSeries(
    [Delete.exports.subscription, Delete.exports.blogs, Delete.exports.user],
    req,
    res,
    callback
  );
}

function collectCandidates(done) {
  var candidates = [];

  eachUser(
    function (user, next) {
      var candidate =
        candidateFromCancellation(user) || candidateFromOverdue(user);

      if (!candidate) return next();

      async.map(
        user.blogs || [],
        function (blogID, blogDone) {
          Blog.get({ id: blogID }, blogDone);
        },
        function (err, blogs) {
          if (err) return next(err);

          candidate.blogs = blogs.filter(Boolean);
          candidates.push(candidate);

          next();
        }
      );
    },
    function (err) {
      done(err, candidates);
    }
  );
}

function runFastMode(candidates, done) {
  if (!candidates.length) return done(null, 0);

  candidates.forEach(function (candidate, index) {
    console.log((index + 1) + ". " + describeCandidateSummary(candidate));
  });

  var prompt = FAST_CONFIRMATION_PROMPT.replace("<count>", candidates.length);

  getConfirmation(prompt, function (_, yes) {
    if (!yes) {
      console.log(colors.red("Deletion cancelled."));
      return done(null, 0);
    }

    var deleted = 0;

    async.eachSeries(candidates, function (candidate, next) {
      deleteAccount(candidate.user, function (deleteErr) {
        if (deleteErr) return next(deleteErr);
        deleted += 1;
        console.log(colors.green("Deleted " + candidate.user.email));
        next();
      });
    }, function (err) {
      done(err, deleted);
    });
  });
}

function runInteractiveMode(candidates, done) {
  var deleted = 0;

  async.eachSeries(
    candidates,
    function (candidate, next) {
      getConfirmation(
        describeUser(candidate, candidate.blogs),
        function (_, yes) {
          if (!yes) {
            console.log(colors.red("Skipped " + candidate.user.email));
            return next();
          }

          deleteAccount(candidate.user, function (deleteErr) {
            if (deleteErr) return next(deleteErr);
            deleted += 1;
            console.log(colors.green("Deleted " + candidate.user.email));
            next();
          });
        }
      );
    },
    function (err) {
      done(err, deleted);
    }
  );
}

console.log("Scanning for cancelled and overdue users that passed their grace period...");
if (!FAST_MODE) {
  console.log("Tip: use -fast to review all candidates and confirm once.");
}

collectCandidates(function (err, candidates) {
  if (err) throw err;

  var runMode = FAST_MODE ? runFastMode : runInteractiveMode;

  runMode(candidates, function (runErr, deleted) {
    if (runErr) throw runErr;
    console.log("Done. Candidates:", candidates.length, "Deleted:", deleted);
    process.exit();
  });
});
