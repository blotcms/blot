const config = require("config");
const path = require("path");
const net = require("net");
const clfdate = require("helper/clfdate");
const { ErrorReply, MultiErrorReply } = require("redis");

const PAGE = path.resolve(__dirname + "/../views/error-redis-unavailable.html");

// node-redis rejects with these when the client cannot reach the server
const CLIENT_ERROR_NAMES = new Set([
  "ClientOfflineError",
  "ClientClosedError",
  "ConnectionTimeoutError",
  "SocketTimeoutError",
  "SocketClosedUnexpectedlyError",
  "ReconnectStrategyError",
]);

// Redis is reachable but not serving, or is refusing writes: -LOADING while it
// reads its dataset after a restart, -MASTERDOWN when a replica has lost its
// master, -READONLY on a replica, -NOREPLICAS when min-replicas-to-write is
// not satisfied (we use that to freeze writes during a host cutover), -OOM
// at maxmemory with noeviction, -MISCONF when persistence is failing, and
// -EXECABORT when a queued command in a MULTI was rejected for one of these
// reasons. This is the same outage seen from the other side, so treat it the
// same way.
const NOT_SERVING_REPLY =
  /^(LOADING|MASTERDOWN|CLUSTERDOWN|TRYAGAIN|READONLY|NOREPLICAS|OOM|MISCONF|EXECABORT)\b/;

// Network errors are only ours if they were aimed at the Redis server,
// otherwise an unreachable third party (Dropbox, Stripe) looks like an outage
const SOCKET_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
]);

function isRedisUnavailableError(err, depth = 0) {
  if (!err || typeof err !== "object" || depth > 2) return false;

  if (CLIENT_ERROR_NAMES.has(err.constructor && err.constructor.name)) {
    return true;
  }

  // node-redis raises server errors as SimpleError or BlobError, both of
  // which extend ErrorReply, so match on the base class rather than its name
  if (err instanceof ErrorReply) {
    if (NOT_SERVING_REPLY.test(String(err.message))) return true;

    // A MULTI/EXEC where some commands failed carries each reply, errors
    // included, rather than the server's message
    if (err instanceof MultiErrorReply) {
      for (const reply of err.errors()) {
        if (isRedisUnavailableError(reply, depth + 1)) return true;
      }
    }
  }

  if (SOCKET_ERROR_CODES.has(err.code)) {
    const redis = config.redis || {};
    // Node reports the target as port + address (connect) or hostname (lookup)
    const target = err.address !== undefined ? err.address : err.hostname;
    const hostIsName = net.isIP(String(redis.host)) === 0;

    if (err.port !== undefined) {
      // Node reports the resolved IP, so when the configured host is a DNS
      // name (dev, test) only the port can be compared
      const hostMatches =
        target === undefined || target === redis.host || hostIsName;
      if (Number(err.port) === Number(redis.port) && hostMatches) return true;
    } else if (target !== undefined && target === redis.host) {
      // Lookup failures carry no port, so the name itself must be Redis's
      return true;
    }
  }

  return isRedisUnavailableError(err.cause || err.originalError, depth + 1);
}

// Express error middleware: any request that failed because Redis is
// unreachable gets a 503 and a generic page, everything else passes through.
function redisUnavailableHandler(err, req, res, next) {
  if (!isRedisUnavailableError(err)) return next(err);

  console.error(
    clfdate(),
    req.headers && req.headers["x-request-id"] || "-",
    "Redis unavailable:",
    err.message
  );

  // Response already started, nothing more we can tell the client
  if (res.headersSent) return res.end();

  res.status(503);
  res.set({ "Retry-After": "60", "Cache-Control": "no-store" });
  res.sendFile(PAGE, function (sendErr) {
    if (sendErr && !res.headersSent) res.type("text").send("Service unavailable");
  });
}

module.exports = { isRedisUnavailableError, redisUnavailableHandler };
