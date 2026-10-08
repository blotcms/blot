const scheduler = require("node-schedule");
const scheduled = new Map();
const timeoutFallbacks = new Map();
var ensure = require("helper/ensure");
var model = require("./model");
var clfdate = require("helper/clfdate");
var { isRedisUnavailableError } = require("helper/redisUnavailable");

// If the re-save is rejected because Redis is unavailable (or frozen for a
// host cutover) the entry would stay scheduled until the next restart
var REFRESH_RETRY_MS = 60 * 1000;

module.exports = function (blogID, entry, callback) {
  ensure(blogID, "string").and(entry, model).and(callback, "function");

  var set = require("./set");

  // Use a deterministic key to ensure one scheduled job per entry path.
  // We reschedule whenever the entry's publication date changes.
  var key = [blogID, entry.path].join(":");

  // Refresh will perform a re-save of the entry
  var refresh = function () {
    set(blogID, entry.path, {}, function (err) {
      if (err && isRedisUnavailableError(err)) {
        console.error(
          clfdate(),
          "Blog:",
          blogID + ":",
          "Could not publish entry as scheduled, will retry",
          entry.path,
          err.message
        );
        var retry = setTimeout(function () {
          timeoutFallbacks.delete(key);
          refresh();
        }, REFRESH_RETRY_MS);
        if (typeof retry.unref === "function") retry.unref();
        timeoutFallbacks.set(key, retry);
        return;
      }

      // Retried in the background if Redis is unavailable
      require("models/blog").bumpCacheID(blogID, function (err) {
        console.log(
          "Blog:",
          blogID + ":",
          "Published entry as scheduled!",
          entry.path
        );
      });
    });
  };

  var existing = scheduled.get(key);

  if (existing) {
    existing.cancel();
    scheduled.delete(key);
  }

  var existingTimeout = timeoutFallbacks.get(key);

  if (existingTimeout) {
    clearTimeout(existingTimeout);
    timeoutFallbacks.delete(key);
  }

  // If the entry is scheduled for future publication,
  // register an event to update the entry. This is
  // neccessary to switch the 'scheduled' flag
  if (!entry.scheduled) return callback();

  var at = new Date(entry.dateStamp);
  var delay = at.getTime() - Date.now();

  if (delay <= 0) {
    setImmediate(refresh);
    return callback();
  }

  // node-schedule handles long delays; setTimeout fallback helps
  // test environments using mocked timers reliably fire publication.
  if (delay <= 0x7fffffff) {
    var timeout = setTimeout(function () {
      timeoutFallbacks.delete(key);
      var existingJob = scheduled.get(key);
      if (existingJob) {
        existingJob.cancel();
        scheduled.delete(key);
      }
      refresh();
    }, delay);

    if (typeof timeout.unref === "function") timeout.unref();

    timeoutFallbacks.set(key, timeout);
  }

  var job = scheduler.scheduleJob(at, refresh);

  if (job) {
    scheduled.set(key, job);

    job.on("run", function () {
      scheduled.delete(key);

      var fallbackTimeout = timeoutFallbacks.get(key);
      if (fallbackTimeout) {
        clearTimeout(fallbackTimeout);
        timeoutFallbacks.delete(key);
      }
    });

    job.on("canceled", function () {
      scheduled.delete(key);

      var fallbackTimeout = timeoutFallbacks.get(key);
      if (fallbackTimeout) {
        clearTimeout(fallbackTimeout);
        timeoutFallbacks.delete(key);
      }
    });
  }

  return callback();
};
