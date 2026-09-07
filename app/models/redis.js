const config = require("config");
const redis = require("redis");
const instrumentRedis = require("helper/instrumentRedis");

const url = `redis://${config.redis.host}:${config.redis.port}`;
const clientSideCaches = new WeakMap();

function createRedisClient() {
  const clientSideCache = new redis.BasicClientSideCache({
    ttl: 0,
    maxEntries: 3333,
    evictPolicy: "LRU",
  });

  const client = redis.createClient({
    url,
    RESP: 3,
    maintNotifications: "disabled",
    commandOptions: { timeout: undefined },
    socket: { keepAliveInitialDelay: 5000 },
    clientSideCache,
  });

  clientSideCaches.set(client, clientSideCache);

  return instrumentRedis("models", client, url);
}

// Only expose an immutable stats snapshot, rather than the controllable cache.
// This keeps cache mutation limited to node-redis itself.
createRedisClient.getClientSideCacheStats = function (client) {
  const clientSideCache = clientSideCaches.get(client);
  return clientSideCache ? clientSideCache.stats() : null;
};

module.exports = createRedisClient;
