const clfdate = require("helper/clfdate");
const lock = require("sync/lock");

// Graceful shutdown on SIGTERM/SIGINT: stop accepting connections, let
// in-flight requests and syncs finish, release folder locks, then exit.
//
// This must stay under the containers' --stop-timeout (30s, see
// proxy/deploy/common.sh), after which Docker SIGKILLs.
const DRAIN_TIMEOUT_MS = parseInt(process.env.BLOT_DRAIN_TIMEOUT_MS) || 25000;
const LOCK_POLL_MS = 100;

// The final release is best effort (the TTL frees anything we miss), so it
// gets a short cap that fits in the gap before Docker's SIGKILL.
const RELEASE_TIMEOUT_MS = 2000;

let draining = false;
let httpServers = [];
let promise = null;
const listeners = new Set();

function isDraining() {
  return draining;
}

// Registers fn to run when draining begins (used to end long-lived SSE
// responses, which would otherwise hold server.close() open). If fn returns a
// promise, the drain also waits for it, within the timeout (a forked worker
// child exiting, see helper/workerChild). Returns an unsubscribe function.
function onStart(fn) {
  if (draining) {
    setImmediate(fn);
    return function () {};
  }
  listeners.add(fn);
  return function () {
    listeners.delete(fn);
  };
}

// Call once per server (the TCP listener and the Unix socket one)
function setServer(server) {
  httpServers.push(server);
}

function start({ timeout = DRAIN_TIMEOUT_MS } = {}) {
  if (promise) return promise;
  promise = run(timeout);
  return promise;
}

async function run(timeout) {
  const startedAt = Date.now();
  draining = true;
  console.log(clfdate(), "[DRAIN] starting");

  // No new syncs from here on, so once held locks reach zero they stay there
  lock.stopAcquiring();

  const waits = [];
  for (const fn of [...listeners]) {
    try {
      const result = fn();
      if (result && typeof result.then === "function") {
        waits.push(
          Promise.resolve(result).catch((err) =>
            console.error(clfdate(), "[DRAIN] listener error", err)
          )
        );
      }
    } catch (err) {
      console.error(clfdate(), "[DRAIN] listener error", err);
    }
  }
  listeners.clear();

  const servers = [...httpServers];

  // Closing the listener (rather than answering 503) is what makes nginx fail
  // over to the backup upstream: it does not retry on a 503, but does on a
  // refused connection.
  const closed = new Promise((resolve) => {
    let pending = servers.length;
    if (!pending) return resolve();
    for (const server of servers) {
      server.close(() => --pending === 0 && resolve());
      server.closeIdleConnections();
    }
  });

  const locksReleased = new Promise((resolve) => {
    const poll = () => {
      if (lock.heldCount() === 0) return resolve();
      setTimeout(poll, LOCK_POLL_MS).unref();
    };
    poll();
  });

  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve(true), timeout);
    timer.unref();
  });

  const didTimeOut = await Promise.race([
    Promise.all([closed, locksReleased, ...waits]).then(() => false),
    timedOut,
  ]);
  clearTimeout(timer);

  if (didTimeOut) {
    console.log(
      clfdate(),
      "[DRAIN] timed out",
      `heldLocks=${lock.heldCount()}`
    );
    for (const server of servers) server.closeAllConnections();
  }

  let releaseTimer;
  await Promise.race([
    lock.releaseAll(),
    new Promise((resolve) => {
      releaseTimer = setTimeout(resolve, RELEASE_TIMEOUT_MS);
      releaseTimer.unref();
    }),
  ]);
  clearTimeout(releaseTimer);

  console.log(clfdate(), "[DRAIN] done", `${Date.now() - startedAt}ms`);
}

// Note app/clients/local/init.js also has process.once("SIGTERM"/"SIGINT")
// cleanup listeners; they coexist with these (they don't exit), and this
// handler is the one that exits. Returns a function that removes the handlers.
function install({ timeout = DRAIN_TIMEOUT_MS, exit = process.exit } = {}) {
  const handler = function (signal) {
    if (draining) {
      console.log(clfdate(), "[DRAIN] second", signal, "- exiting now");
      return exit(1);
    }
    console.log(clfdate(), "[DRAIN] received", signal);
    start({ timeout }).then(
      () => exit(0),
      (err) => {
        console.error(clfdate(), "[DRAIN] failed", err);
        exit(1);
      }
    );
  };
  process.on("SIGTERM", handler);
  process.on("SIGINT", handler);
  return function uninstall() {
    process.removeListener("SIGTERM", handler);
    process.removeListener("SIGINT", handler);
  };
}

function _reset() {
  draining = false;
  httpServers = [];
  promise = null;
  listeners.clear();
  lock.resumeAcquiring();
}

module.exports = {
  isDraining,
  onStart,
  setServer,
  start,
  install,
  DRAIN_TIMEOUT_MS,
  _reset,
};
