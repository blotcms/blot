const { monitorEventLoopDelay } = require("perf_hooks");
const { Worker } = require("worker_threads");
const path = require("path");
const clfdate = require("helper/clfdate");

// Logs when this process's event loop is blocked. A blocked loop delays
// every request, and it also starves the folder-lock heartbeat
// (app/sync/lock.js): if the loop stalls for longer than the lock TTL the
// lock expires and the process deliberately crashes.
//
// 1. Always on (cheap): a native delay histogram, read every INTERVAL_MS and
//    logged only when the worst delay in that window exceeds LOG_THRESHOLD_MS.
// 2. Opt-in with BLOT_EVENT_LOOP_PROFILE=true: a worker thread samples the
//    main thread's JS stacks and logs the heaviest ones for any window that
//    contained a stall, which says *what* was blocking. The sampler has a
//    small constant cost, so leave it off unless you are investigating.

const INTERVAL_MS = 10 * 1000;
const LOG_THRESHOLD_MS = 500;

let started = false;

const ms = (nanoseconds) => Math.round(nanoseconds / 1e6);

function start() {
  if (started) return;
  started = true;

  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();

  const timer = setInterval(() => {
    const max = ms(histogram.max);
    if (max >= LOG_THRESHOLD_MS) {
      console.log(
        clfdate(),
        "[EVENT LOOP] lag",
        `max=${max}ms`,
        `p99=${ms(histogram.percentile(99))}ms`,
        `p50=${ms(histogram.percentile(50))}ms`,
        `window=${INTERVAL_MS / 1000}s`
      );
    }
    histogram.reset();
  }, INTERVAL_MS);
  timer.unref();

  if (process.env.BLOT_EVENT_LOOP_PROFILE === "true") startProfiler();
}

function startProfiler() {
  // The main thread bumps a counter; the worker notices when it stops moving.
  const shared = new Int32Array(new SharedArrayBuffer(4));
  const beat = setInterval(() => Atomics.add(shared, 0, 1), 100);
  beat.unref();

  const worker = new Worker(path.join(__dirname, "eventLoopMonitorWorker.js"), {
    workerData: { shared, windowMs: 5 * 1000, stallMs: 1000 },
  });
  worker.unref();
  worker.on("message", (message) => {
    console.log(clfdate(), "[EVENT LOOP] stall profile", message);
  });
  worker.on("error", (err) => {
    console.error(clfdate(), "[EVENT LOOP] profiler stopped", err);
  });
}

// Measures event loop delay over a stretch of work, e.g. one blog's
// validation, so a stall can be attributed to what was running. Call the
// returned function when the work is done; it returns the worst and p99
// delay plus the elapsed time, all in ms. Delay is process-wide, so
// concurrent requests and syncs are included; compare against other blogs.
function measure() {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  const startedAt = Date.now();
  histogram.enable();
  return function stop() {
    histogram.disable();
    return {
      durationMs: Date.now() - startedAt,
      maxLagMs: ms(histogram.max),
      p99LagMs: ms(histogram.percentile(99)),
    };
  };
}

module.exports = { start, measure };
