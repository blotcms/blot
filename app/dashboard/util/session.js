const config = require("config");
const crypto = require("crypto");
const session = require("express-session");
const { RedisStore } = require("connect-redis");
const redis = require("redis");

// connect-redis 9 uses the promise API (get/set/del with options), so use
// a native redis client, not the shared application singleton from models/client.
const sessionClient = redis.createClient({
  url: `redis://${config.redis.host}:${config.redis.port}`,
  RESP: 2,
  commandOptions: { timeout: undefined },
  socket: { keepAliveInitialDelay: 5000 },
});
sessionClient.connect().catch((err) => {
  console.error("Session Redis connect error:", err);
});

// Hosted production sets BLOT_SESSION_SECRET. Self-hosted and development
// installs may omit it, so keep those installs usable with a process-local,
// cryptographically secure secret and make the resulting session invalidation
// on restart explicit. Never use helper/guid here: it is an identifier helper,
// uses Math.random, and is not suitable for signing or other security purposes.
const sessionSecret =
  config.session.secret || crypto.randomBytes(32).toString("hex");

if (!config.session.secret) {
  console.warn(
    "BLOT_SESSION_SECRET is not set; using a secure ephemeral secret. " +
      "Dashboard sessions will be invalidated when this process restarts.",
  );
}

// Session settings. It is important that session
// comes before the cache so we know what to serve
module.exports = session({
  secret: sessionSecret,
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
