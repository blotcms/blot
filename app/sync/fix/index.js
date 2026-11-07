const Blog = require("models/blog");
const entryGhosts = require("./entry-ghosts");
const listGhosts = require("./list-ghosts");
const menuGhosts = require("./menu-ghosts");
const tagGhosts = require("./tag-ghosts");
const entriesPathIndex = require("./entries-path-index");
const withCallback = require("helper/withCallback");
const clfdate = require("helper/clfdate");

// Each check below issues many small, sequential Redis round trips (e.g.
// entry-ghosts reads every entry one at a time) without holding the blog's
// folder lock, so it's invisible to sync/lock-diagnostics's pendingSyncs -
// a [LOCK COMPROMISED] elsewhere gave no sign Fix() was running at all.
// Tracking the currently-running checks here lets lock-diagnostics report
// them. Fix() runs for more than one blog at a time in this process (the
// Dropbox and iCloud hourly validators and user-triggered dashboard fixes
// all call it independently), so this is keyed per call, not a singleton -
// a single shared variable would get clobbered by whichever call started
// most recently and misattribute a compromise to the wrong blog.
let nextCallID = 0;
const runningChecks = new Map();

function getRunningChecks() {
  return Array.from(runningChecks.values());
}

// Runs the checks one after the other and settles with { error, report }:
// it never rejects, because a check failing part way still leaves the
// repairs made before that, and the callers want both.
const run = withCallback(async function run(blog, status) {
  const finalReport = {};
  const checks = [
    { name: "entry-ghosts", fn: entryGhosts },
    { name: "tag-ghosts", fn: tagGhosts },
    { name: "list-ghosts", fn: listGhosts },
    { name: "menu-ghosts", fn: menuGhosts },
    { name: "entries-path-index", fn: entriesPathIndex },
  ];
  let current = 0;
  let error = null;
  const callID = nextCallID++;

  for (const check of checks) {
    current += 1;
    status(`(${current}/${checks.length}) Checking ${check.name}`);
    const startedAt = Date.now();
    runningChecks.set(callID, {
      blogID: blog.id,
      check: check.name,
      startedAt,
    });

    let report;
    let checkError = null;

    try {
      report = await check.fn(blog);
    } catch (err) {
      checkError = err;
    }

    runningChecks.delete(callID);
    console.log(
      clfdate(),
      "Fix:",
      blog.id,
      check.name,
      `duration=${Date.now() - startedAt}ms`
    );

    if (checkError) {
      error = checkError;
      break;
    }

    if (report && report.length) finalReport[check.name] = report;
  }

  runningChecks.delete(callID);

  // if final report is empty return immediately
  if (!Object.keys(finalReport).length) {
    return { error, report: finalReport };
  }

  // otherwise set cacheID to force cache invalidation
  const cacheID = Date.now();
  let setError = null;

  try {
    await Blog.set(blog.id, { cacheID });
  } catch (err) {
    setError = err;
  }

  // A check earlier in the series may have already failed - don't let
  // a successful cacheID bump on Blog.set mask that error.
  return { error: error || setError, report: finalReport };
});

// Fix() only returns what it repaired: callback(err, finalReport), where
// finalReport is { [checkName]: items[] }. It doesn't email. Callers decide
// what to report - the hourly sweeps fold it into one digest per sweep (see
// clients/util/syncReport.js) rather than one email per repaired blog.
// It keeps its callback, and has no promise form, because it calls back with
// both an error and the report (withCallback would drop the report on error).
module.exports = function (blog, options, callback) {
  if (!blog) {
    throw new TypeError("Fix: Expected blog as first argument");
  }

  if (typeof options === "function") {
    callback = options;
    options = {};
  }

  if (typeof callback !== "function") {
    throw new TypeError("Fix: Expected callback as second argument");
  }

  // Callers that don't pass a status (the legacy two-argument API used by
  // startup/hourly validators) never published one before this progress
  // work was added. Keep that silent instead of writing a real messenger's
  // status to Blog.setStatus - a "(n/5) Checking ..." message with no
  // terminal follow-up would otherwise leave the dashboard showing that
  // blog as syncing forever.
  const status = options.status || function () {};

  run(blog, status, function (err, outcome) {
    // Only a check's status function throwing gets here
    if (err) return callback(err, {});

    callback(outcome.error, outcome.report);
  });
};

module.exports.getRunningChecks = getRunningChecks;
