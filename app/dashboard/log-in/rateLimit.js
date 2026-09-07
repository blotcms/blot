const { rateLimit}  = require("express-rate-limit");
const { RedisStore } = require('rate-limit-redis')
const redis = require("redis");
const config = require("config");

// rate-limit-redis uses the promise API (get/set/del with options), so use
// a native redis client, not the shared application singleton from models/client.
const client = redis.createClient({
  url: `redis://${config.redis.host}:${config.redis.port}`,
  RESP: 2,
  commandOptions: { timeout: undefined },
  socket: { keepAliveInitialDelay: 5000 },
});
client.connect().catch((err) => {
  console.error("Rate limit Redis connect error:", err);
});

var limiter = rateLimit({
  store: new RedisStore({
    prefix: "rate-limit:log-in:",
    // Redis store configuration
		sendCommand: (command, ...args) => client.sendCommand([command, ...args]),
  }),
  windowMs: 60000, // one minute window
  max: 120, // 2 attempts per second
});

module.exports = limiter;
