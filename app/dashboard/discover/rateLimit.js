const { rateLimit } = require("express-rate-limit");
const { RedisStore } = require("rate-limit-redis");
const createRedisClient = require("models/redis");

// The manage page is only for the maintainer's account; a limit a person
// clicking through it never reaches bounds anything else. rate-limit-redis
// uses the promise API, so this is a native client, as in log-in/rateLimit.
const client = createRedisClient.createLibraryClient("Discover rate limit");

module.exports = rateLimit({
  store: new RedisStore({
    prefix: "rate-limit:discover:",
    sendCommand: (command, ...args) => client.sendCommand([command, ...args]),
  }),
  windowMs: 60000,
  max: 60,
});
