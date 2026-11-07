const clfdate = require("helper/clfdate");
const { performance } = require("perf_hooks");
const config = require("config");

const DEVELOPMENT = config.environment === "development";
// A response this slow (in seconds), or a 5xx, prints its steps
const SLOW_SECONDS = 1;
// Steps held per request; a blog render logs a few dozen
const MAX_STEPS = 200;

module.exports = function requestLogger(req, res, next) {
  const requestStart = Date.now();
  // Share of the request's wall time the event loop spent busy (on this
  // request or any other). Near 1: blocked on CPU. Near 0: waiting on I/O.
  const eluStart = performance.eventLoopUtilization();
  const requestId = req.headers["x-request-id"] || "no-request-id";

  function formatRequestUrl() {
    return `${req.protocol}://${req.hostname}${req.originalUrl}`;
  }

  function createLogEntry(...args) {
    return [clfdate(), requestId, ...args].join(" ");
  }

  // Initial request logging
  try {
    console.log(createLogEntry(formatRequestUrl(), req.method));
  } catch (err) {
    console.error("Error logging request:", err);
  }

  // Add request-scoped logging helpers. Remembers the longest gap between
  // steps so the response line can say where a slow request spent its time.
  // Outside development req.log holds its steps until the response, and prints
  // them only for a slow or failed request or one the client left: they were
  // over half of all log lines, and the response line says where a fast one
  // spent its time. req.logNow prints at once, for a line that matters on any
  // request ([folder-asset]).
  let lastLogTime = Date.now();
  let slowestGap = 0;
  let slowestStep = [];
  let steps = [];
  let droppedSteps = 0;

  function step(args) {
    const now = Date.now();
    const timeDiff = now - lastLogTime;
    lastLogTime = now;
    if (timeDiff > slowestGap) {
      slowestGap = timeDiff;
      slowestStep = args;
    }
    return createLogEntry(`+${timeDiff}ms`, ...args);
  }

  req.log = function (...args) {
    const entry = step(args);
    if (DEVELOPMENT) console.log(entry);
    else if (steps.length < MAX_STEPS) steps.push(entry);
    else droppedSteps++;
  };

  req.logNow = function (...args) {
    console.log(step(args));
  };

  function printSteps() {
    for (const entry of steps) console.log(entry);
    if (droppedSteps) {
      console.log(createLogEntry(`(${droppedSteps} more steps not logged)`));
    }
    steps = [];
    droppedSteps = 0;
  }

  // Response logging
  res.on("finish", () => {
    try {
      const seconds = (Date.now() - requestStart) / 1000;
      const duration = seconds.toFixed(3);
      const elu = performance.eventLoopUtilization(eluStart).utilization;
      const fields = [
        res.statusCode,
        duration,
        formatRequestUrl(),
        `elu=${elu.toFixed(2)}`,
      ];
      // The step logged after the longest gap, i.e. what that time led up to.
      // Only for requests that logged steps (blog renders, mostly).
      const tail = Date.now() - lastLogTime;
      if (slowestStep.length && tail > slowestGap) {
        slowestGap = tail;
        slowestStep = ["(response finished)"];
      }
      if (slowestStep.length) {
        const slowest = slowestStep.join(" ").replace(/\s+/g, " ").slice(0, 80);
        fields.push(`slowest=+${slowestGap}ms:${JSON.stringify(slowest)}`);
      }
      if (res.statusCode >= 500 || seconds >= SLOW_SECONDS) printSteps();
      else steps = [];
      console.log(createLogEntry(...fields));
    } catch (err) {
      console.error("Error logging response:", err);
    }
  });

  // Listen on res, not req: req emits "close" as soon as its body has been
  // fully read (e.g. by body-parser on POSTs), long before the client leaves.
  // https://github.com/expressjs/express/issues/6334
  res.on("close", () => {
    if (res.writableFinished) return;
    try {
      printSteps();
      console.log(
        createLogEntry("Connection closed by client", formatRequestUrl())
      );
    } catch (err) {
      console.error("Error logging connection close:", err);
    }
  });

  next();
};
