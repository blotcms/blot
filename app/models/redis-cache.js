const redis = require("redis");

// Key classes, matched against the full key. Order matters: the first match
// wins, so the specific blog:* classes come before the generic "list" one.
const CLASSES = [
  ["info", /^blog:[^:]+:info$/],
  ["domain", /^domain:/],
  ["handle", /^handle:/],
  ["template", /^template:[^:]+:[^:]+:info$/], // template IDs are owner:slug
  ["patterns", /^template:[^:]+:[^:]+:url_patterns$/],
  ["owners", /^template:owned_by:[^:]+$/],
  ["session", /^sess:/],
  ["user", /^user:[^:]+:info$/],
  ["url", /^blog:[^:]+:url:/],
  ["entry", /^blog:[^:]+:entry:/],
  ["tags", /^blog:[^:]+:tags:/],
  ["list", /^blog:/],
];

// Small, hot keys read on nearly every blog or dashboard request, rarely
// written, and no more numerous than blogs, templates, users or sessions.
// Keys named after a request path (entries, entry and template URLs,
// redirects) are left out: crawlers and scanners would flood the cache and
// evict these, and Redis tracks every key read, even a missing one, until it
// is written, so they would also refill the server's tracking table.
const ALLOWED = new Set([
  "info",
  "domain",
  "handle",
  "template",
  "patterns",
  "owners",
  "session",
  "user",
]);

function classify(key) {
  key = String(key);
  for (const [name, pattern] of CLASSES) if (pattern.test(key)) return name;
  return "other";
}

// A command is cached only if it has keys and every one is allowlisted. The
// returned class names the command in the counters: the first key's class
// when allowed, otherwise the first key class which is not allowed.
function classifyKeys(keys) {
  if (!keys || !keys.length) return { cache: false, className: "other" };
  const classes = keys.map(classify);
  const blocked = classes.find((name) => !ALLOWED.has(name));
  return blocked
    ? { cache: false, className: blocked }
    : { cache: true, className: classes[0] };
}

// Redis invalidates a key on every connection tracking it, including the one
// which wrote it, but sends that push after the reply to the write. The client
// can act on the reply before the push has been read (they can arrive in
// separate chunks, which happens under load), so a read straight after our own
// write could be served the value cached before it. The client therefore
// forgets allowlisted keys itself as it sends a write (see forgetWrittenKeys,
// wired up by models/redis); the push which follows only repeats that.

// Client-side cache which only caches (and asks the server to track) an
// allowlist of keys. Tracking runs in OPTIN mode, so the server remembers a
// key for this connection only after CLIENT CACHING YES precedes the read.
class AllowlistClientSideCache extends redis.BasicClientSideCache {
  constructor(options) {
    super(options);
    // Cumulative per-class counters: { info: { hits, misses, bypass } }
    this.classStats = {};
    // True while a read is being sent, so it is not mistaken for a write
    this.sendingRead = false;
  }

  // Drops the cached values for every allowlisted key named in a command's
  // arguments, as the command is sent. Called for every command except the
  // cached reads, so any write (a plain command, a script or a MULTI) counts.
  // A read in flight when this runs is not cached when its reply arrives, and
  // a read sent afterwards reaches Redis behind the write on this connection.
  forgetWrittenKeys(args) {
    if (this.sendingRead || !Array.isArray(args)) return;
    for (const arg of args) {
      if (typeof arg === "string" && ALLOWED.has(classify(arg)))
        redis.BasicClientSideCache.prototype.invalidate.call(this, arg);
    }
  }

  sendRead(fn) {
    this.sendingRead = true;
    try {
      return fn();
    } finally {
      this.sendingRead = false;
    }
  }

  trackingOn() {
    return ["CLIENT", "TRACKING", "ON", "OPTIN"];
  }

  count(className, field) {
    const stats =
      this.classStats[className] ||
      (this.classStats[className] = { hits: 0, misses: 0, bypass: 0 });
    stats[field]++;
  }

  async handleCache(client, parser, fn, transformReply, typeMapping) {
    const { cache, className } = classifyKeys(parser.keys);

    if (!cache) {
      this.count(className, "bypass");
      // Same as the base class's miss path: transform the raw reply, but
      // neither read from nor write to the cache.
      const reply = await this.sendRead(fn);
      return transformReply
        ? transformReply(reply, parser.preserve, typeMapping)
        : reply;
    }

    // The base class only calls this on a miss, so a hit sends nothing
    let sent = false;
    const send = () => {
      sent = true;
      this.count(className, "misses");
      // Both commands go onto the client's write queue in this one
      // synchronous tick, so nothing can slip between them on the wire, and
      // Redis applies CACHING YES to the next command: the read.
      return this.sendRead(() => {
        client.sendCommand(["CLIENT", "CACHING", "YES"]).catch(() => {});
        return fn();
      });
    };

    const result = await super.handleCache(
      client,
      parser,
      send,
      transformReply,
      typeMapping
    );
    // The wrapper did not run, so the base class served it from the cache
    // (or waited on a read already in flight)
    if (!sent) this.count(className, "hits");
    return result;
  }
}

AllowlistClientSideCache.classify = classify;
AllowlistClientSideCache.classifyKeys = classifyKeys;

module.exports = AllowlistClientSideCache;
