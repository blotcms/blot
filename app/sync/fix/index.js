const Blog = require("models/blog");
const entryGhosts = require("./entry-ghosts");
const listGhosts = require("./list-ghosts");
const menuGhosts = require("./menu-ghosts");
const tagGhosts = require("./tag-ghosts");
const entriesPathIndex = require("./entries-path-index");
const archivesIndex = require("./archives-index");
const async = require("async");
const callOnce = require("helper/callOnce");

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
    { name: "archives-index", fn: archivesIndex },
  ];
  let current = 0;

  async.eachSeries(
    checks,
    function (check, next) {
      current += 1;
      status(`(${current}/${checks.length}) Checking ${check.name}`);
      check.fn(
        blog,
        callOnce(function (err, report) {
          if (err) return next(err);
          if (report && report.length) finalReport[check.name] = report;
          next();
        })
      );
    },
    function (err) {
      // if final report is empty return immediately
      if (!Object.keys(finalReport).length) {
        return callback(err, finalReport);
      }

      // otherwise set cacheID to force cache invalidation
      const cacheID = Date.now();
      Blog.set(blog.id, { cacheID }, function (err) {
        callback(err, finalReport);
      });
    }
  );
};
