const { rateLimit}  = require("express-rate-limit");
const { RedisStore } = require('rate-limit-redis')
const createRedisClient = require("models/redis");

// rate-limit-redis uses the promise API (get/set/del with options), so use
// a native redis client, not the shared application singleton from models/client.
const client = createRedisClient.createLibraryClient("Rate limit");

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
