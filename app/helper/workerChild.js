const childProcess = require("child_process");
const clfdate = require("helper/clfdate");

// Forks a worker child and keeps it running (#2119).
//
// The child runs the same app (script) and serves HTTP on its own Unix socket
// only, for the reverse proxy to send it the requests that sync or build
// (webhooks, /clients, dashboard writes), so they never block the parent's
// event loop while it serves blogs and dashboard pages. Both run the same
// background jobs, which Redis locks and leases share out between every
// process, so either may pick up a given one.
//
// A child that exits is forked again after a delay that doubles from
// minBackoffMs to maxBackoffMs, and starts again from minBackoffMs once a
// child has run for stableMs. stop() sends it SIGTERM, which the child
// handles with its own drain (helper/drain), and resolves once it has
// exited. Its drain timeout is shorter than the parent's, so it is done
// before the parent's drain gives up waiting. onExit(reason) is called for
// every child that ends without stop() having been called, before it is
// forked again.
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30 * 1000;
const STABLE_MS = 60 * 1000;
const DRAIN_MARGIN_MS = 3000;
// The child barely renders, so its in-memory render caches get a tenth of the
// usual caps (config.cache_scale) unless BLOT_WORKER_CACHE_SCALE says otherwise
const DEFAULT_CACHE_SCALE = "0.1";

module.exports = function workerChild({
  script,
  socket,
  maxOldSpaceSize = null,
  drainTimeoutMs,
  env = process.env,
  fork = childProcess.fork,
  minBackoffMs = MIN_BACKOFF_MS,
  maxBackoffMs = MAX_BACKOFF_MS,
  stableMs = STABLE_MS,
  onExit = null,
}) {
  if (!script) throw new TypeError("workerChild: script is required");
  if (!socket) throw new TypeError("workerChild: socket is required");

  const log = (...args) => console.log(clfdate(), "[WORKER]", ...args);

  let child = null;
  let stopping = false;
  let restartTimer = null;
  let backoffMs = minBackoffMs;

  const childEnv = Object.assign({}, env, {
    BLOT_WORKER_CHILD: "true",
    BLOT_SOCKET: socket,
    BLOT_WORKER_SOCKET: "",
    BLOT_CACHE_SCALE: env.BLOT_WORKER_CACHE_SCALE || DEFAULT_CACHE_SCALE,
  });

  if (drainTimeoutMs) {
    childEnv.BLOT_DRAIN_TIMEOUT_MS = String(
      Math.max(1000, drainTimeoutMs - DRAIN_MARGIN_MS)
    );
  }

  // Command-line flags win over the NODE_OPTIONS the child inherits, so this
  // gives it its own heap cap rather than the parent's
  const execArgv = process.execArgv.concat(
    maxOldSpaceSize ? ["--max-old-space-size=" + maxOldSpaceSize] : []
  );

  function start() {
    restartTimer = null;
    const startedAt = Date.now();

    // Called once per child, when it exits or could not be spawned
    let ended = false;
    function restart(reason) {
      if (ended) return;
      ended = true;
      if (child === forked) child = null;
      if (stopping) return;

      if (Date.now() - startedAt >= stableMs) backoffMs = minBackoffMs;

      log(reason, "restarting in " + backoffMs + "ms");
      if (onExit) {
        try {
          onExit(reason);
        } catch (err) {
          log("onExit threw", err.message);
        }
      }

      restartTimer = setTimeout(start, backoffMs);
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
    }

    let forked = null;
    try {
      forked = fork(script, [], { env: childEnv, execArgv });
    } catch (err) {
      return restart("Could not fork: " + err.message);
    }

    child = forked;
    log("Started", "pid=" + forked.pid);

    forked.on("exit", function (code, signal) {
      restart("Exited pid=" + forked.pid + " code=" + code + " signal=" + signal);
    });

    // An unhandled "error" would crash this process. A failed spawn (no pid)
    // emits it and may never emit "exit"; other errors, such as a failed
    // kill, leave the child running.
    forked.on("error", function (err) {
      if (forked.pid === undefined) return restart("Could not spawn: " + err.message);
      log("Error", "pid=" + forked.pid, err.message);
    });
  }

  function stop() {
    stopping = true;
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;

    const running = child;
    if (!running) return Promise.resolve();

    return new Promise(function (resolve) {
      running.once("exit", resolve);
      log("Stopping", "pid=" + running.pid);
      running.kill("SIGTERM");
    });
  }

  start();

  return {
    stop,
    get pid() {
      return child ? child.pid : null;
    },
  };
};
