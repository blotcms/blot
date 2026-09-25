const os = require("os");
const { promisify } = require("util");
const freeDiskSpace = require("../scheduler/free-disk-space");
const {
  getPendingSyncs,
  getPendingUpdates
} = require("./lock-diagnostics-state");

const folderLock = require("./lock");
const { getRunningChecks } = require("./fix");
const freeDiskSpaceAsync = promisify(freeDiskSpace);
const DEFAULT_TIMEOUT_MS = 2000;

const serializeError = error => {
  if (!error) return null;

  return {
    message: error.message,
    code: error.code,
    stack: error.stack
  };
};

const runWithTimeout = (fn, timeoutMs) => {
  if (timeoutMs <= 0) {
    return Promise.resolve({ timedOut: true });
  }

  return Promise.race([
    (async () => {
      try {
        const value = await fn();
        return { value };
      } catch (error) {
        return { error: serializeError(error) };
      }
    })(),
    new Promise(resolve => {
      setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    })
  ]);
};

const addResult = (target, key, result) => {
  if (result.value !== undefined) {
    target[key] = result.value;
    return;
  }

  if (result.error) {
    target[`${key}Error`] = result.error;
    return;
  }

  if (result.timedOut) {
    target[`${key}Error`] = { timedOut: true };
  }
};

const gatherLockDiagnostics = async ({
  blogID,
  lockAcquiredAt,
  syncContext,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) => {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const now = Date.now();

  const diagnostics = {
    blogID,
    now,
    pendingSyncs: getPendingSyncs(),
    pendingUpdates: getPendingUpdates(),
    // Fix() doesn't hold the folder lock while it runs, so it's absent from
    // pendingSyncs above - this is the only way to see it was in progress.
    // An array because more than one blog's Fix() can run at once (the
    // Dropbox/iCloud validators and dashboard fixes all call it
    // independently) - this compromise may not even involve the blog above.
    runningFixChecks: getRunningChecks().map(runningCheck => ({
      blogID: runningCheck.blogID,
      check: runningCheck.check,
      runningForMs: now - runningCheck.startedAt
    })),
    lockDurationMs:
      typeof lockAcquiredAt === "number" ? now - lockAcquiredAt : null,
    processUptimeSec: (() => {
      try {
        return process.uptime();
      } catch (error) {
        return null;
      }
    })()
  };

  if (syncContext) {
    diagnostics.syncContext = syncContext;
  }

  const timeLeft = () => Math.max(0, deadline - Date.now());

  addResult(
    diagnostics,
    "process",
    await runWithTimeout(
      () => ({
        pid: process.pid,
        nodeVersion: process.version,
        memoryUsage: process.memoryUsage(),
        cpuUsage: process.cpuUsage ? process.cpuUsage() : null
      }),
      timeLeft()
    )
  );

  addResult(
    diagnostics,
    "load",
    await runWithTimeout(
      () => ({
        loadavg: os.loadavg(),
        cpuCount: os.cpus().length
      }),
      timeLeft()
    )
  );

  addResult(
    diagnostics,
    "diskSpace",
    await runWithTimeout(() => freeDiskSpaceAsync(), timeLeft())
  );

  if (blogID) {
    addResult(
      diagnostics,
      "lockState",
      await runWithTimeout(() => folderLock.inspect(blogID), timeLeft())
    );
  }

  if (Date.now() > deadline) {
    diagnostics.timedOut = true;
    diagnostics.timeoutMs = timeoutMs;
  }

  return diagnostics;
};

module.exports = gatherLockDiagnostics;
