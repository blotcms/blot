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
  ["readonly", /^blot:read-only$/],
  ["user", /^user:[^:]+:info$/],
  ["url", /^blog:[^:]+:url:/],
  ["entry", /^blog:[^:]+:entry:/],
  ["tags", /^blog:[^:]+:tags:/],
  ["list", /^blog:/],
];

// Small, hot keys read on nearly every blog or dashboard request, rarely
// written, and no more numerous than blogs, templates, users or sessions.
// The read-only freeze (helper/readOnly) is one key, read by every dashboard
// page and almost always missing; Redis tracks a missing key too, so "not
// frozen" is served locally until an operator sets it.
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
  "readonly",
]);

// Classes with their own bounded share of the cache, each evicting its own
// least recently used entry when full, so they can never push out the blog,
// domain, handle and template keys every blog request reads. Those share the
// rest, and models/redis sizes the whole cache's maxEntries above these caps
// plus every blog's hot keys, so a full capped class never makes the cache
// evict anything else. URL patterns are read on every render too, but there is
// a set for every template, installed or not, so previews could flood it.
const CLASS_CAPS = {
  patterns: 2000,
  owners: 500,
  session: 500,
  user: 500,
};

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
    // Cumulative per-class counters:
    // { info: { hits, misses, bypass, evictions } }
    this.classStats = {};
    // True while a read is being sent, so it is not mistaken for a write
    this.sendingRead = false;
    this.classCaps = (options && options.classCaps) || CLASS_CAPS;
    // Per capped class, its cache keys from least to most recently used,
    // and each listed cache key's class
    this.cappedOrder = new Map();
    this.cappedClassOf = new Map();
  }

  // The base class stores every entry through set() and reads it through
  // get(), so these keep each capped class's own LRU order beside it.
  set(cacheKey, cacheEntry, keys) {
    const className = keys && keys.length ? classify(keys[0]) : null;
    const cap = className && this.classCaps[className];
    if (!cap) return super.set(cacheKey, cacheEntry, keys);

    let order = this.cappedOrder.get(className);
    if (!order) this.cappedOrder.set(className, (order = new Map()));

    // Make room in this class first: if the whole cache is full, the base
    // class would otherwise evict its oldest entry, maybe a blog record, to
    // fit this one, and the class would then shrink back to its cap anyway.
    if (!order.has(cacheKey) && order.size >= cap)
      this.trimClass(className, order, cap - 1);

    super.set(cacheKey, cacheEntry, keys);
    order.delete(cacheKey);
    order.set(cacheKey, true);
    this.cappedClassOf.set(cacheKey, className);
  }

  get(cacheKey) {
    const entry = super.get(cacheKey);
    const className = entry !== undefined && this.cappedClassOf.get(cacheKey);
    if (className) {
      const order = this.cappedOrder.get(className);
      order.delete(cacheKey);
      order.set(cacheKey, true);
    }
    return entry;
  }

  delete(cacheKey) {
    super.delete(cacheKey);
    const className = this.cappedClassOf.get(cacheKey);
    if (!className) return;
    this.cappedOrder.get(className).delete(cacheKey);
    this.cappedClassOf.delete(cacheKey);
  }

  clear(resetStats) {
    super.clear(resetStats);
    this.cappedOrder.clear();
    this.cappedClassOf.clear();
  }

  // Entries the base class dropped without going through delete() (an
  // invalidation, or its own eviction) are still listed: forget those first,
  // so they don't count against the cap, then evict this class's least
  // recently used entries until it fits.
  trimClass(className, order, cap) {
    for (const cacheKey of order.keys()) {
      if (this.has(cacheKey)) continue;
      order.delete(cacheKey);
      this.cappedClassOf.delete(cacheKey);
    }
    while (order.size > cap) {
      this.delete(order.keys().next().value);
      this.recordEvictions(1);
      this.count(className, "evictions");
    }
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
      (this.classStats[className] = {
        hits: 0,
        misses: 0,
        bypass: 0,
        evictions: 0,
      });
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
AllowlistClientSideCache.CLASS_CAPS = CLASS_CAPS;

module.exports = AllowlistClientSideCache;
