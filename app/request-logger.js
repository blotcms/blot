const clfdate = require("helper/clfdate");

module.exports = function requestLogger(req, res, next) {
  const requestStart = Date.now();
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

  // Add request-scoped logging helper
  let lastLogTime = Date.now();
  req.log = function(...args) {
    const now = Date.now();
    const timeDiff = now - lastLogTime;
    lastLogTime = now;
    
    console.log(createLogEntry(`+${timeDiff}ms`, ...args));
  };

  // Response logging
  res.on("finish", () => {
    try {
      const duration = ((Date.now() - requestStart) / 1000).toFixed(3);
      console.log(createLogEntry(
        res.statusCode,
        duration,
        formatRequestUrl()
      ));
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