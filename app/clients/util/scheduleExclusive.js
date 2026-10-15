const lock = require("helper/lock");
const drain = require("helper/drain");
const clfdate = require("helper/clfdate");

// Wraps fn so a call while another call (in any process) is still running is
// skipped with a log line instead of overlapping it. The lock is held with a
// heartbeat, so a run may take as long as it needs, and expires on its own
// if the process holding it dies.
function exclusive(name, fn) {
  const key = name + ":running";

  return async function (...args) {
    let held;
    try {
      held = await lock(key);
    } catch (err) {
      if (err.code === "ELOCKED" || err.code === "ESLOW") {
        console.log(clfdate(), name + ": previous run still going, skipping");
        return;
      }
      throw err;
    }

    try {
      return await fn(...args);
    } finally {
      await held.release().catch((err) => {
        if (err.code !== "ECOMPROMISED")
          console.error(clfdate(), name + ": error releasing run lock", err);
      });
    }
  };
}

// A cron job run by one process per fire date (see helper/lock cron), which
// stops being scheduled when this process starts draining. Returns the
// node-schedule job.
function schedule(name, rule, fn, options) {
  const job = lock.cron(name, rule, fn, options);
  drain.onStart(() => job.cancel());
  return job;
}

// schedule() whose runs also never overlap across processes, for jobs that
// can outlast their interval.
function scheduleExclusive(name, rule, fn, options) {
  return schedule(name, rule, exclusive(name, fn), options);
}

module.exports = scheduleExclusive;
module.exports.schedule = schedule;
module.exports.exclusive = exclusive;
