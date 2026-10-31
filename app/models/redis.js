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
// use TCP to a Redis the operator did not mean. node-redis connects over IPC
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

  if (config.redis.socket) return { socket: { ...socket, path: config.redis.socket } };

  return { url, socket };
}

// Pass { clientSideCache: false } for a client which never reads cacheable
// keys (the pubsub subscriber), so Redis does not track anything for it.
function createRedisClient({ clientSideCache: useCache = true } = {}) {
  const clientSideCache = useCache
    ? new AllowlistClientSideCache({
        ttl: 0,
        maxEntries: 3333,
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

  if (clientSideCache) clientSideCaches.set(client, clientSideCache);
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
