const config = require("config");
const guid = require("helper/guid");
const session = require("express-session");
const { RedisStore } = require("connect-redis");
const redis = require("redis");
const reconnectStrategy = require("helper/redisReconnectStrategy");

// connect-redis 9 uses the promise API (get/set/del with options), so use
// a native redis client, not the shared application singleton from models/client.
const sessionClient = redis.createClient({
  url: `redis://${config.redis.host}:${config.redis.port}`,
  RESP: 2,
  commandOptions: { timeout: undefined },
  socket: { keepAliveInitialDelay: 5000, reconnectStrategy },
});
// node-redis emits 'error' for every runtime socket failure after connecting
// (e.g. an idle connection reaped with ETIMEDOUT shortly after a deploy). Without
// a listener Node rethrows it as an uncaught exception and the process crashes.
sessionClient.on("error", (err) => {
  console.error("Session Redis error:", err);
});
sessionClient.connect().catch((err) => {
  console.error("Session Redis connect error:", err);
});

// Session settings. It is important that session
// comes before the cache so we know what to serve
module.exports = session({
  // If no session secret is set we use a random GUID
  // this will mean that sessions will only be valid
  // for as long as the process is running.
  secret: config.session.secret || guid(),
  saveUninitialized: false,
  resave: false,
  proxy: true,
  cookie: {
    httpOnly: true, // prevent the cookie's exposure to client-side js
    secure: true, // ensure the cookie is only accesible over HTTPS
    domain: "", // prevent the cookie's exposure to sub domains
    sameSite: true, // prevent the cookie's exposure to other sites
    maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days in ms
  },
  store: new RedisStore({ client: sessionClient }),
});


