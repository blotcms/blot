const config = require("config");
const crypto = require("crypto");
const session = require("express-session");
const { RedisStore } = require("connect-redis");
// connect-redis 9 uses node-redis' promise API (get/set/del with options),
// which the shared client has too. On the shared client session and user
// reads are served from its client-side cache (models/redis-cache), so most
// dashboard requests skip a round trip for each.
const client = require("models/client");

const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

// Without rolling sessions the browser cookie's expiry only moves when the
// session is modified, and a modified session is saved. So touch (an EXPIRE
// at the end of every unmodified request, which the response waits for) only
// kept sessions in Redis past their cookie, and would invalidate the cached
// session on every request. connect-redis derives the TTL from the stored
// cookie's expiry, which a req.session.save() made before the response still
// holds at its old value while the cookie sent goes out with a fresh
// MAX_AGE_MS. A fixed TTL keeps every save in Redis at least as long as the
// cookie it goes with.
const store = new RedisStore({
  client,
  disableTouch: true,
  ttl: () => MAX_AGE_MS / 1000,
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
      "Dashboard sessions will be invalidated when this process restarts."
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
    maxAge: MAX_AGE_MS,
  },
  store,
});

module.exports.store = store;
module.exports.MAX_AGE_MS = MAX_AGE_MS;
