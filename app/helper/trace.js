var Debug = require("debug");
var config = require("config");

// Export a version of this function which does nothing in production
if (config.environment !== "development") {
  module.exports = function () {
    return function (req, res, next) {
      req.trace = function () {};
      next();
    };
  };

  module.exports.init = function (req, res, next) {
    next();
  };

  return;
}

function prefix(req) {
  return "blot:trace:" + req.originalUrl;
}

module.exports = function (message) {
  return function (req, res, next) {
    if (req.trace) req.trace(message);
    next();
  };
};

module.exports.init = function (req, res, next) {
  var start = Date.now();

  if (req.trace) {
    throw new Error("Already definied");
  }

  req.trace = Debug(prefix(req));
  req.trace("request recieved (init invoked)");

  res.on("finish", function () {
    var duration = Date.now() - start;
    req.trace("\x1b[32m%s\x1b[0m", duration + "ms", "taken to finish response");
  });

  next();
};
