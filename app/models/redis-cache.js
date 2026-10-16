const redis = require("redis");

// Key classes, matched against the full key. Order matters: the first match
// wins, so the specific blog:* classes come before the generic "list" one.
const CLASSES = [
  ["info", /^blog:[^:]+:info$/],
  ["domain", /^domain:/],
  ["handle", /^handle:/],
  ["template", /^template:[^:]+:[^:]+:info$/], // template IDs are owner:slug
  ["url", /^blog:[^:]+:url:/],
  ["entry", /^blog:[^:]+:entry:/],
  ["tags", /^blog:[^:]+:tags:/],
  ["list", /^blog:/],
];

// Small, hot keys read on nearly every request. Entries and URLs are left out
// because a big blog (or a crawler) would flood the cache and evict these.
const ALLOWED = new Set(["info", "domain", "handle", "template"]);

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

// Client-side cache which only caches (and asks the server to track) an
// allowlist of keys. Tracking runs in OPTIN mode, so the server remembers a
// key for this connection only after CLIENT CACHING YES precedes the read.
class AllowlistClientSideCache extends redis.BasicClientSideCache {
  constructor(options) {
    super(options);
    // Cumulative per-class counters: { info: { hits, misses, bypass } }
    this.classStats = {};
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
      const reply = await fn();
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
      client.sendCommand(["CLIENT", "CACHING", "YES"]).catch(() => {});
      return fn();
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
