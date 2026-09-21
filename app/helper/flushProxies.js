// The process-wide purge queue for the reverse proxies in config. Shared so
// every caller draws from one queue and one rate limit, and so failed purges
// are recorded in (and retried from) Redis.
const config = require("config");
const client = require("models/client");
const flushCache = require("./flushCache");
const flushCachePending = require("./flushCachePending");

module.exports = flushCache({
  reverse_proxies: config.reverse_proxies,
  token: config.purge_token,
  pending: flushCachePending(client),
});
