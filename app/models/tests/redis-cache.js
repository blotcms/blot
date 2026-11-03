describe("models/redis-cache", function () {
  const Cache = require("models/redis-cache");

  it("classifies keys by their full format", function () {
    const cases = {
      "blog:blog_123:info": "info",
      "domain:example.com": "domain",
      "handle:david": "handle",
      "template:SITE:blog:info": "template",
      "template:blog_123:my-theme:info": "template",
      "template:SITE:blog:view:entry.html": "other",
      "template:SITE:blog:url_patterns": "patterns",
      "template:SITE:blog:url:/": "other",
      "template:SITE:blog:all_views": "other",
      "template:owned_by:SITE": "owners",
      "template:owned_by:blog_123": "owners",
      "sess:abc123": "session",
      "user:user_123:info": "user",
      "user:user_123:paypal_cancel_email:sub_1": "other",
      "blog:blog_123:url:/foo": "url",
      "blog:blog_123:entry:/foo.txt": "entry",
      "blog:blog_123:tags:all": "tags",
      "blog:blog_123:status": "list",
      "blog:blog_123:info:extra": "list",
      "blogs": "other",
      "total:blogs": "other",
    };
    Object.keys(cases).forEach(function (key) {
      expect(Cache.classify(key)).toBe(cases[key], key);
    });
  });

  it("caches only when every key is allowlisted", function () {
    expect(Cache.classifyKeys([]).cache).toBe(false);
    expect(Cache.classifyKeys(undefined).cache).toBe(false);
    expect(Cache.classifyKeys(["blog:x:info"])).toEqual({
      cache: true,
      className: "info",
    });
    expect(Cache.classifyKeys(["blog:x:info", "domain:a.com"]).cache).toBe(true);
    [
      "template:SITE:blog:url_patterns",
      "template:owned_by:SITE",
      "sess:abc",
      "user:user_1:info",
    ].forEach(function (key) {
      expect(Cache.classifyKeys([key]).cache).toBe(true, key);
    });
    [
      "template:SITE:blog:url:/wp-login.php",
      "template:SITE:blog:view:entry.html",
      "blog:x:redirect:/a",
    ].forEach(function (key) {
      expect(Cache.classifyKeys([key]).cache).toBe(false, key);
    });
    expect(Cache.classifyKeys(["blog:x:info", "blog:x:entry:/a"])).toEqual({
      cache: false,
      className: "entry",
    });
  });

  it("opts in to tracking", function () {
    expect(new Cache({ ttl: 0, maxEntries: 10, evictPolicy: "LRU" }).trackingOn())
      .toEqual(["CLIENT", "TRACKING", "ON", "OPTIN"]);
  });

  describe("per-class caps", function () {
    function cache(classCaps) {
      return new Cache({ ttl: 0, maxEntries: 100, evictPolicy: "LRU", classCaps });
    }

    function store(c, key) {
      c.set("GET " + key, c.createValueEntry(null, key), [key]);
    }

    it("evicts a capped class's own oldest entry, never another class's", function () {
      const c = cache({ session: 2 });
      store(c, "blog:b1:info");
      store(c, "sess:a");
      store(c, "sess:b");
      store(c, "sess:c");

      expect(c.has("GET blog:b1:info")).toBe(true);
      expect(c.has("GET sess:a")).toBe(false);
      expect(c.has("GET sess:b")).toBe(true);
      expect(c.has("GET sess:c")).toBe(true);
      expect(c.classStats.session.evictions).toBe(1);
      expect(c.stats().evictionCount).toBe(1);
    });

    it("keeps a capped entry that was just read", function () {
      const c = cache({ session: 2 });
      store(c, "sess:a");
      store(c, "sess:b");
      c.get("GET sess:a");
      store(c, "sess:c");

      expect(c.has("GET sess:a")).toBe(true);
      expect(c.has("GET sess:b")).toBe(false);
    });

    it("doesn't count entries the cache already dropped against the cap", function () {
      const c = cache({ session: 2 });
      store(c, "sess:a");
      store(c, "sess:b");
      c.invalidate("sess:a");
      store(c, "sess:c");

      expect(c.has("GET sess:b")).toBe(true);
      expect(c.has("GET sess:c")).toBe(true);
      expect((c.classStats.session || {}).evictions || 0).toBe(0);
    });

    it("makes room in its own class before the cache-wide limit evicts", function () {
      const c = new Cache({
        ttl: 0,
        maxEntries: 3,
        evictPolicy: "LRU",
        classCaps: { session: 1 },
      });
      store(c, "blog:b1:info");
      store(c, "blog:b2:info");
      store(c, "sess:a");
      store(c, "sess:b");

      expect(c.has("GET blog:b1:info")).toBe(true);
      expect(c.has("GET blog:b2:info")).toBe(true);
      expect(c.has("GET sess:a")).toBe(false);
      expect(c.has("GET sess:b")).toBe(true);
    });

    it("leaves uncapped classes to the cache-wide limit", function () {
      const c = cache({ session: 1 });
      for (let i = 0; i < 50; i++) store(c, "blog:b" + i + ":info");
      expect(c.size()).toBe(50);
      expect(c.stats().evictionCount).toBe(0);
    });

    it("forgets its order when the cache is cleared", function () {
      const c = cache({ session: 2 });
      store(c, "sess:a");
      store(c, "sess:b");
      c.clear();
      store(c, "sess:c");
      store(c, "sess:d");
      expect(c.has("GET sess:c")).toBe(true);
      expect(c.has("GET sess:d")).toBe(true);
    });

    it("leaves room above the caps for the blog keys", function () {
      const createRedisClient = require("models/redis");
      const client = createRedisClient();
      const { maxEntries } = createRedisClient.getClientSideCacheStats(client);
      const capped = Object.values(Cache.CLASS_CAPS).reduce((a, b) => a + b, 0);
      expect(maxEntries).toBeGreaterThan(capped * 2);
    });
  });

  // Needs a live Redis, like the other specs in this folder
  it("caches an info key but not an entry key", async function () {
    const createRedisClient = require("models/redis");
    const client = createRedisClient();
    await client.connect();
    const id = "blog:cachespec" + Date.now();
    try {
      await client.set(id + ":info", "a");
      await client.set(id + ":entry:/a", "b");
      for (let i = 0; i < 2; i++) {
        await client.get(id + ":info");
        await client.get(id + ":entry:/a");
      }
      const { classStats } = createRedisClient.getClientSideCacheStats(client);
      expect(classStats.info).toEqual({ hits: 1, misses: 1, bypass: 0, evictions: 0 });
      expect(classStats.entry).toEqual({ hits: 0, misses: 0, bypass: 2, evictions: 0 });

      // The server only tracks the key if CACHING YES reached it right
      // before the read, so a write must invalidate the cached value.
      await client.set(id + ":info", "c");
      expect(await client.get(id + ":info")).toBe("c");
    } finally {
      await client.del([id + ":info", id + ":entry:/a"]);
      await client.quit();
    }
  });

  // Redis sends the invalidation for a key after the reply to the write which
  // changed it, and a busy connection can deliver the two in separate reads,
  // so the code awaiting the write runs before the invalidation does. Reading
  // straight after a write then returned the value cached before it (a new
  // template's metadata read as missing). Dropping the pushes here leaves the
  // client's own bookkeeping as the only thing keeping the cache honest.
  describe("with the server's invalidations arriving late", function () {
    const createRedisClient = require("models/redis");
    let client, id;

    beforeEach(async function () {
      client = createRedisClient();
      await client.connect();
      client.clientSideCache.invalidate = function () {};
      id = "template:blog_cachespec" + Date.now() + ":late:info";
    });

    afterEach(async function () {
      await client.del(id);
      await client.quit();
    });

    it("reads its own write", async function () {
      expect(await client.hGetAll(id)).toEqual({});
      await client.hSet(id, { a: "1" });
      expect(await client.hGetAll(id)).toEqual({ a: "1" });
    });

    it("reads its own write made in a MULTI", async function () {
      expect(await client.hGetAll(id)).toEqual({});
      await client.multi().hSet(id, { a: "1" }).exec();
      expect(await client.hGetAll(id)).toEqual({ a: "1" });
    });

    it("reads its own write made by a script", async function () {
      expect(await client.hGetAll(id)).toEqual({});
      await client.eval("return redis.call('HSET', KEYS[1], 'a', '1')", {
        keys: [id],
      });
      expect(await client.hGetAll(id)).toEqual({ a: "1" });
    });

    it("does not cache a read which a write overtook", async function () {
      const read = client.hGetAll(id);
      await client.hSet(id, { a: "1" });
      await read;
      expect(await client.hGetAll(id)).toEqual({ a: "1" });
    });
  });
});
