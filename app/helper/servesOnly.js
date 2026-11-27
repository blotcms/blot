const config = require("config");

// Whether this process only serves (#2990): in a unit, node-a, the process
// which forks a worker child (helper/workerChild), serves blogs and dashboard
// reads and nothing else. Its worker child, node-b, runs the background jobs
// that sync and build (follow-up syncs, rebuilds, the scheduler, the
// clients' pollers), so a build that blocks the event loop or crashes the
// process can't hold up published sites. A process without a worker child
// (a single process: the specs, scripts) runs them itself.
module.exports = function servesOnly() {
  return !!config.worker_socket && !config.worker_child;
};
