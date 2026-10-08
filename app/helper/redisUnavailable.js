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
// at maxmemory with noeviction, and -MISCONF when persistence is failing.
// This is the same outage seen from the other side, so treat it the same way.
// -EXECABORT is left out: it also follows ordinary syntax errors in a MULTI,
// and the reply that caused it is classified on its own (node-redis rejects
// multi().exec() with that reply).
const NOT_SERVING_CODES =
  "LOADING|MASTERDOWN|CLUSTERDOWN|TRYAGAIN|READONLY|NOREPLICAS|OOM|MISCONF";
const NOT_SERVING_REPLY = new RegExp("^(" + NOT_SERVING_CODES + ")\\b");

// A write refused inside EVAL or EVALSHA comes back wrapped, e.g.
// "ERR Error running script (call to f_<sha>): @user_script:1: @user_script: 1:
// -NOREPLICAS Not enough good replicas to write." Only the code after a "-"
// counts, so a script that merely mentions READONLY in its own error does not.
const NOT_SERVING_SCRIPT_REPLY = new RegExp(
  "^ERR Error running script\\b[\\s\\S]*\\s-(" + NOT_SERVING_CODES + ")\\b"
);

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

// Commands in flight when the server resets the connection reject with the
// bare socket error ("read ECONNRESET", no address or port), the same object
// the client emits as its "error" event. Our clients (models/redis) record
// those here, which tells them apart from an ECONNRESET on, say, a Dropbox
// request, and costs nothing when the error is never rejected into a command.
const clientSocketErrors = new WeakSet();

function markRedisClientError(err) {
  if (err && typeof err === "object") clientSocketErrors.add(err);
}

function isRedisUnavailableError(err, depth = 0) {
  if (!err || typeof err !== "object" || depth > 2) return false;

  if (CLIENT_ERROR_NAMES.has(err.constructor && err.constructor.name)) {
    return true;
  }

  // node-redis raises server errors as SimpleError or BlobError, both of
  // which extend ErrorReply, so match on the base class rather than its name
  if (err instanceof ErrorReply) {
    const message = String(err.message);
    if (NOT_SERVING_REPLY.test(message)) return true;
    if (NOT_SERVING_SCRIPT_REPLY.test(message)) return true;

    // A MULTI/EXEC where some commands failed carries each reply, errors
    // included, rather than the server's message
    if (err instanceof MultiErrorReply) {
      for (const reply of err.errors()) {
        if (isRedisUnavailableError(reply, depth + 1)) return true;
      }
    }
  }

  if (SOCKET_ERROR_CODES.has(err.code)) {
    if (clientSocketErrors.has(err)) return true;

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

module.exports = {
  isRedisUnavailableError,
  redisUnavailableHandler,
  markRedisClientError,
};
