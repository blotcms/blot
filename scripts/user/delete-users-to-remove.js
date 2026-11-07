var colors = require("colors/safe");
var eachUser = require("../each/user");
var getConfirmation = require("../util/getConfirmation");
var Delete = require("dashboard/account/delete");
var Blog = require("models/blog");
var removal = require("models/user/removal");

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
  console.log(
    "  -fast, --fast  list all candidates first and confirm once before deleting"
  );
  console.log("  -h, --help     show this help output");
}

if (HELP_FLAG) {
  printUsage();
  process.exit(0);
}

function overdueFor(user) {
  return removal.overdueFor(user);
}

// Runs one of the Delete steps (callback-style); rejects with its error
function runStep(step, req, res) {
  return new Promise(function (resolve, reject) {
    step(req, res, function (err) {
      if (err) return reject(err);
      resolve();
    });
  });
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

function logUserError(user, action, err) {
  console.error(
    colors.red(
      "Error " +
        action +
        " " +
        user.email +
        " " +
        user.uid +
        ": " +
        ((err && err.message) || err)
    )
  );
}

async function deleteAccount(user) {
  var req = { user: user };
  var res = {};

  for (const step of [
    Delete.exports.subscription,
    Delete.exports.blogs,
    Delete.exports.user,
  ]) {
    await runStep(step, req, res);
  }
}

async function collectCandidates() {
  var candidates = [];

  async function withBlogs(user, candidate) {
    var blogs;

    try {
      blogs = await Promise.all(
        (user.blogs || []).map(function (blogID) {
          return Blog.get({ id: blogID });
        })
      );
    } catch (err) {
      logUserError(user, "loading blogs for", err);
      return;
    }

    candidate.blogs = blogs.filter(Boolean);
    candidates.push(candidate);
  }

  await eachUser(async function (user) {
    var overdue;

    try {
      overdue = await overdueFor(user);
    } catch (err) {
      logUserError(user, "checking overdue status for", err);
      return;
    }

    var candidate = removal.removalCandidate(user, overdue);

    if (!candidate) return;

    await withBlogs(user, candidate);
  });

  return candidates;
}

async function runFastMode(candidates) {
  if (!candidates.length) return 0;

  candidates.forEach(function (candidate, index) {
    console.log(index + 1 + ". " + describeCandidateSummary(candidate));
  });

  var prompt = FAST_CONFIRMATION_PROMPT.replace("<count>", candidates.length);

  var yes = await getConfirmation(prompt);

  if (!yes) {
    console.log(colors.red("Deletion cancelled."));
    return 0;
  }

  var deleted = 0;

  for (const candidate of candidates) {
    try {
      await deleteAccount(candidate.user);
    } catch (deleteErr) {
      logUserError(candidate.user, "deleting", deleteErr);
      continue;
    }

    deleted += 1;
    console.log(colors.green("Deleted " + candidate.user.email));
  }

  return deleted;
}

async function runInteractiveMode(candidates) {
  var deleted = 0;

  for (const candidate of candidates) {
    var yes = await getConfirmation(describeUser(candidate, candidate.blogs));

    if (!yes) {
      console.log(colors.red("Skipped " + candidate.user.email));
      continue;
    }

    try {
      await deleteAccount(candidate.user);
    } catch (deleteErr) {
      logUserError(candidate.user, "deleting", deleteErr);
      continue;
    }

    deleted += 1;
    console.log(colors.green("Deleted " + candidate.user.email));
  }

  return deleted;
}

async function run() {
  console.log(
    "Scanning for cancelled and overdue users that passed their grace period..."
  );
  if (!FAST_MODE) {
    console.log("Tip: use -fast to review all candidates and confirm once.");
  }

  var candidates = await collectCandidates();

  var deleted = FAST_MODE
    ? await runFastMode(candidates)
    : await runInteractiveMode(candidates);

  console.log("Done. Candidates:", candidates.length, "Deleted:", deleted);
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
