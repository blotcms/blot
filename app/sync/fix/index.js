const Blog = require("models/blog");
const entryGhosts = require("./entry-ghosts");
const listGhosts = require("./list-ghosts");
const menuGhosts = require("./menu-ghosts");
const tagGhosts = require("./tag-ghosts");
const entriesPathIndex = require("./entries-path-index");
const async = require("async");
const callOnce = require("helper/callOnce");
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

  const finalReport = {};
  // Callers that don't pass a status (the legacy two-argument API used by
  // startup/hourly validators) never published one before this progress
  // work was added. Keep that silent instead of writing a real messenger's
  // status to Blog.setStatus - a "(n/5) Checking ..." message with no
  // terminal follow-up would otherwise leave the dashboard showing that
  // blog as syncing forever.
  const status = options.status || function () {};
  const checks = [
    { name: "entry-ghosts", fn: entryGhosts },
    { name: "tag-ghosts", fn: tagGhosts },
    { name: "list-ghosts", fn: listGhosts },
    { name: "menu-ghosts", fn: menuGhosts },
    { name: "entries-path-index", fn: entriesPathIndex },
  ];
  let current = 0;
  const callID = nextCallID++;

  async.eachSeries(
    checks,
    function (check, next) {
      current += 1;
      status(`(${current}/${checks.length}) Checking ${check.name}`);
      const startedAt = Date.now();
      runningChecks.set(callID, { blogID: blog.id, check: check.name, startedAt });
      check.fn(
        blog,
        callOnce(function (err, report) {
          runningChecks.delete(callID);
          console.log(
            clfdate(),
            "Fix:",
            blog.id,
            check.name,
            `duration=${Date.now() - startedAt}ms`
          );
          if (err) return next(err);
          if (report && report.length) finalReport[check.name] = report;
          next();
        })
      );
    },
    function (err) {
      runningChecks.delete(callID);

      // if final report is empty return immediately
      if (!Object.keys(finalReport).length) {
        return callback(err, finalReport);
      }

      // otherwise set cacheID to force cache invalidation
      const cacheID = Date.now();
      Blog.set(blog.id, { cacheID }, function (setErr) {
        // A check earlier in the series may have already failed - don't let
        // a successful cacheID bump on Blog.set mask that error.
        callback(err || setErr, finalReport);
      });
    }
  );
};

module.exports.getRunningChecks = getRunningChecks;
