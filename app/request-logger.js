const clfdate = require("helper/clfdate");
const { performance } = require("perf_hooks");

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
    return [
      clfdate(),
      requestId,
      ...args
    ].join(" ");
  }

  // Initial request logging
  try {
    console.log(createLogEntry(formatRequestUrl(), req.method));
  } catch (err) {
    console.error("Error logging request:", err);
  }

  // Add request-scoped logging helper. Remembers the longest gap between
  // steps so the response line can say where a slow request spent its time.
  let lastLogTime = Date.now();
  let slowestGap = 0;
  let slowestStep = [];
  req.log = function(...args) {
    const now = Date.now();
    const timeDiff = now - lastLogTime;
    lastLogTime = now;
    if (timeDiff > slowestGap) {
      slowestGap = timeDiff;
      slowestStep = args;
    }
    
    console.log(createLogEntry(`+${timeDiff}ms`, ...args));
  };

  // Response logging
  res.on("finish", () => {
    try {
      const duration = ((Date.now() - requestStart) / 1000).toFixed(3);
      const elu = performance.eventLoopUtilization(eluStart).utilization;
      const fields = [
        res.statusCode,
        duration,
        formatRequestUrl(),
        `elu=${elu.toFixed(2)}`
      ];
      // The step logged after the longest gap, i.e. what that time led up to.
      // Only for requests that logged steps (blog renders, mostly).
      const tail = Date.now() - lastLogTime;
      if (slowestStep.length && tail > slowestGap) {
        slowestGap = tail;
        slowestStep = ["(response finished)"];
      }
      if (slowestStep.length) {
        const step = slowestStep.join(" ").replace(/\s+/g, " ").slice(0, 80);
        fields.push(`slowest=+${slowestGap}ms:${JSON.stringify(step)}`);
      }
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
      console.log(createLogEntry(
        "Connection closed by client",
        formatRequestUrl()
      ));
    } catch (err) {
      console.error("Error logging connection close:", err);
    }
  });

  next();
};