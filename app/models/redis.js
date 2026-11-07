const config = require("config");
const redis = require("redis");
const AllowlistClientSideCache = require("./redis-cache");
const { markRedisClientError } = require("helper/redisUnavailable");

const url = `redis://${config.redis.host}:${config.redis.port}`;
const clientSideCaches = new WeakMap();

// A partition where the TCP connection stays up but Redis stops replying
// leaves the client "ready", so commands would wait forever. Pinging keeps
// traffic flowing on a healthy connection; if nothing at all arrives within
// socketTimeout the socket is torn down, pending commands reject with
// SocketTimeoutError and (once connected) new ones reject immediately.
const PING_INTERVAL_MS = 2000;
const SOCKET_TIMEOUT_MS = 6000;

// node-redis' default strategy gives up for good after a SocketTimeoutError,
// which would leave a client closed after a stall until the process restarts.
// Same exponential backoff as the default, but it always retries.
function reconnectStrategy(retries) {
  const jitter = Math.floor(Math.random() * 200);
  return Math.min(Math.pow(2, retries) * 50, 2000) + jitter;
}

// BLOT_REDIS_SOCKET is explicit config, never auto-detected: when it is set
// and the socket is missing the connection fails visibly, it does not quietly
// use TCP to a Redis the maintainer did not mean. node-redis connects over IPC
// when socket.path is present, so the url (which would merge a host and port
// in) is left out. keepAliveInitialDelay is ignored on IPC; socketTimeout and
// reconnectStrategy apply to any transport. Read per client, not at require
// time, so a spec can point config at a socket.
function connectionOptions() {
  const socket = {
    keepAliveInitialDelay: 5000,
    socketTimeout: SOCKET_TIMEOUT_MS,
    reconnectStrategy,
  };

  // node-redis sends CLIENT SETINFO on every new connection and ignores the
  // reply, but Redis 6.2 has no SETINFO (it came in 7.2): each connection
  // added two ERR to Redis's errorstats, which set off the "Redis errors"
  // alert when connections came in bursts (3 Nov 2026).
  const common = { disableClientInfo: true };

  if (config.redis.socket)
    return { ...common, socket: { ...socket, path: config.redis.socket } };

  return { ...common, url, socket };
}

// Makes the client drop cached keys as it sends a command which names them,
// rather than waiting for Redis to push the invalidation, which follows the
// write's reply and can be read after the code awaiting the reply has already
// run (see models/redis-cache). Covers single commands and scripts
// (sendCommand), and MULTI and pipelines, which bypass it.
function forgetOwnWrites(client, cache) {
  // The object createClient returns hands its commands to the client it wraps
  // (_self), which then calls its own sendCommand, so patch that one
  const target = client._self || client;
  const sendCommand = target.sendCommand;
  target.sendCommand = function (args, options) {
    cache.forgetWrittenKeys(args);
    return sendCommand.call(this, args, options);
  };

  ["_executeMulti", "_executePipeline"].forEach(function (name) {
    const execute = target[name];
    target[name] = function (commands, ...rest) {
      for (const command of commands) cache.forgetWrittenKeys(command.args);
      return execute.call(this, commands, ...rest);
    };
  });
}

// The client-side cache serves the blog, domain, handle and template reads
// the render path makes on every request, including the cacheIDs the render
// caches are keyed on. Kept on production evidence, see "Client-side
// caching" in config/redis/README.md.
// Pass { clientSideCache: false } for a client which never reads cacheable
// keys (the pubsub subscriber), so Redis does not track anything for it.
function createRedisClient({ clientSideCache: useCache = true } = {}) {
  const clientSideCache = useCache
    ? new AllowlistClientSideCache({
        ttl: 0,
        // Above the capped classes' shares (CLASS_CAPS in models/redis-cache)
        // plus a few hot keys for every blog (its handle or domain, info,
        // template and patterns), so the blog keys are never evicted to make
        // room.
        //
        // Memory, measured 3 Nov 2026: a cached entry costs about its value's
        // size in the heap plus about 300 bytes of bookkeeping (patterns and
        // owner sets about 2.5x, being many small strings). Worst case per
        // process (node-a, node-b, and each `docker exec` script that walks
        // many blogs) is about 25 MB filled with production's real keys, and
        // at most about 80 MB with every cap full and every entry the size
        // of its class's largest key. To measure again: on the host, sum
        // `MEMORY USAGE` per allowlisted pattern for the largest keys up to
        // each class's cap (read-only); then locally fill this cache with
        // values of those sizes built from flat strings (random bytes, not
        // padEnd, which V8 can share) and compare heapUsed after gc().
        maxEntries: 10000,
        evictPolicy: "LRU",
      })
    : undefined;

  const client = redis.createClient({
    ...connectionOptions(),
    RESP: 3,
    maintNotifications: "disabled",
    commandOptions: { timeout: undefined },
    pingInterval: PING_INTERVAL_MS,
    clientSideCache,
  });

  if (clientSideCache) {
    clientSideCaches.set(client, clientSideCache);
    forgetOwnWrites(client, clientSideCache);
  }
  createRedisClient.failFastOnceReady(client);

  client.on("error", function (err) {
    markRedisClientError(err);
    console.log("Redis Error:");
    console.log(err);
    if (err.trace) console.log(err.trace);
    if (err.stack) console.log(err.stack);
  });

  return client;
}

// By default node-redis queues commands while the server is unreachable and
// retries forever, so every request that touches Redis hangs and the queue
// grows without bound. Once the client has connected successfully we switch
// the queue off so commands reject immediately with ClientOfflineError.
// Before the first connection we keep the queue, because code that runs at
// require time issues commands before connect() has resolved.
createRedisClient.failFast = function (client) {
  client.options.disableOfflineQueue = true;
};

// If Redis is never reached, stop queueing anyway after a grace period, or
// every client created during an outage (the shared one, sessions, the log-in
// rate limiter) would hold requests open until Redis first connects.
const BOOT_QUEUE_MS = 10 * 1000;

createRedisClient.failFastOnceReady = function (client) {
  const timer = setTimeout(function () {
    createRedisClient.failFast(client);
  }, BOOT_QUEUE_MS);
  if (typeof timer.unref === "function") timer.unref();

  client.once("ready", function () {
    clearTimeout(timer);
    createRedisClient.failFast(client);
  });
};

// A client for libraries that use the promise API (connect-redis,
// rate-limit-redis) and so cannot share the application client. It gets the
// same failure detection as the clients above. It logs errors under the given
// label, because an EventEmitter error with no listener kills the process, and
// socket errors are emitted here as well as rejecting commands.
createRedisClient.createLibraryClient = function (label) {
  const client = redis.createClient({
    ...connectionOptions(),
    RESP: 2,
    commandOptions: { timeout: undefined },
    pingInterval: PING_INTERVAL_MS,
  });

  client.on("error", function (err) {
    markRedisClientError(err);
    console.error(label + " Redis error:", err.message);
  });
  createRedisClient.failFastOnceReady(client);
  client.connect().catch(function (err) {
    console.error(label + " Redis connect error:", err);
  });

  return client;
};

createRedisClient.reconnectStrategy = reconnectStrategy;
createRedisClient.PING_INTERVAL_MS = PING_INTERVAL_MS;
createRedisClient.BOOT_QUEUE_MS = BOOT_QUEUE_MS;
createRedisClient.SOCKET_TIMEOUT_MS = SOCKET_TIMEOUT_MS;

// Only expose an immutable stats snapshot, rather than the controllable cache.
// This keeps cache mutation limited to node-redis itself.
createRedisClient.getClientSideCacheStats = function (client) {
  const clientSideCache = clientSideCaches.get(client);
  if (!clientSideCache) return null;

  const stats = clientSideCache.stats();
  // node-redis only bounds this cache by entry count, not by byte size, so
  // entryCount/maxEntries is the only signal for how full it actually is.
  stats.entryCount = clientSideCache.size();
  stats.maxEntries = clientSideCache.maxEntries;
  // Cumulative hits/misses/bypass per key class, see models/redis-cache
  stats.classStats = JSON.parse(JSON.stringify(clientSideCache.classStats));
  return stats;
};

module.exports = createRedisClient;
