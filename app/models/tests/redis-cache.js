describe("models/redis-cache", function () {
  const Cache = require("models/redis-cache");

  it("classifies keys by their full format", function () {
    const cases = {
      "blog:blog_123:info": "info",
      "domain:example.com": "domain",
      "handle:david": "handle",
      "template:SITE:blog:info": "template",
      "template:blog_123:my-theme:info": "template",
      "template:SITE:blog:view:entry.html": "view",
      "template:blog_123:my-theme:view:style.css": "view",
      "template:SITE:blog:url_patterns": "patterns",
      "template:SITE:blog:url:/": "other",
      "template:SITE:blog:all_views": "views",
      "template:SITE:blog:view_sources": "other",
      "template:owned_by:SITE": "owners",
      "template:owned_by:blog_123": "owners",
      "sess:abc123": "session",
      "blot:read-only": "readonly",
      "blot:read-only:extra": "other",
      "user:user_123:info": "user",
      "user:user_123:paypal_cancel_email:sub_1": "other",
      "blog:blog_123:url:/foo": "url",
      "blog:blog_123:entry:/foo.txt": "entry",
      "blog:blog_123:tags:all": "tags",
      "blog:blog_123:status": "list",
      "blog:blog_123:info:extra": "list",
      blogs: "other",
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
    expect(Cache.classifyKeys(["blog:x:info", "domain:a.com"]).cache).toBe(
      true
    );
    [
      "template:SITE:blog:url_patterns",
      "template:owned_by:SITE",
      "template:SITE:blog:view:entry.html",
      "template:SITE:blog:all_views",
      "sess:abc",
      "user:user_1:info",
    ].forEach(function (key) {
      expect(Cache.classifyKeys([key]).cache).toBe(true, key);
    });
    [
      "template:SITE:blog:url:/wp-login.php",
      "template:SITE:blog:view_sources",
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
    expect(
      new Cache({ ttl: 0, maxEntries: 10, evictPolicy: "LRU" }).trackingOn()
    ).toEqual(["CLIENT", "TRACKING", "ON", "OPTIN"]);
  });

  it("names a key's pattern without its IDs, paths or handles", function () {
    const cases = {
      "blog:b1:info": "blog:*:info",
      "blog:b1:entry:/a/b:c": "blog:*:entry:*",
      "blog:b1:url:/x": "blog:*:url:*",
      "blog:b1:dropbox:account": "blog:*:dropbox:account",
      "user:u1:info": "user:*:info",
      "template:owner:slug:url_patterns": "template:*:url_patterns",
      "handle:bob": "handle:*",
      "sess:abc": "sess:*",
      "domain:example.com": "domain:*",
      last_build: "last_build",
      abc123: "*",
    };
    for (const [key, pattern] of Object.entries(cases))
      expect([key, Cache.keyPattern(key)]).toEqual([key, pattern]);
  });

  it("counts writes by command and first key, scripts by their first key", function () {
    const c = new Cache({ ttl: 0, maxEntries: 10, evictPolicy: "LRU" });
    c.forgetWrittenKeys(["HSET", "blog:b1:info", "title", "a"]);
    c.forgetWrittenKeys(["HSET", "blog:b2:info", "title", "b"]);
    c.forgetWrittenKeys(["EVALSHA", "sha", "1", "blog:b1:entry:/a"]);
    c.forgetWrittenKeys(["EVALSHA", "sha", "0"]);
    c.forgetWrittenKeys(["SCAN", "0"]);
    expect([...c.writePatterns]).toEqual([
      ["HSET|blog:*:info", { count: 2, bytes: 0 }],
      ["EVALSHA|blog:*:entry:*", { count: 1, bytes: 0 }],
    ]);
  });

  it("sizes what each class holds, values only", function () {
    const c = new Cache({ ttl: 0, maxEntries: 10, evictPolicy: "LRU" });
    const value = { title: "x".repeat(1000) };
    c.set("GET blog:b1:info", c.createValueEntry(null, value), [
      "blog:b1:info",
    ]);
    c.set("GET sess:a", c.createPromiseEntry(null, new Promise(() => {})), [
      "sess:a",
    ]);
    const sizes = c.classSizes();
    expect(sizes.info.entries).toBe(1);
    expect(sizes.info.bytes).toBeGreaterThan(1000);
    expect(sizes.session).toEqual({ entries: 1, bytes: 0 });
  });

  describe("per-class caps", function () {
    function cache(classCaps) {
      return new Cache({
        ttl: 0,
        maxEntries: 100,
        evictPolicy: "LRU",
        classCaps,
      });
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

    describe("by bytes", function () {
      function viewCache(classByteCaps) {
        return new Cache({
          ttl: 0,
          maxEntries: 100,
          evictPolicy: "LRU",
          classCaps: { view: 50 },
          classByteCaps,
        });
      }

      function storeView(c, name, bytes) {
        const key = "template:SITE:blog:view:" + name;
        const cacheKey = "HGETALL " + key;
        c.set(cacheKey, c.createPromiseEntry(null, new Promise(() => {})), [
          key,
        ]);
        c.set(cacheKey, c.createValueEntry(null, "x".repeat(bytes)), [key]);
        return cacheKey;
      }

      it("evicts a class's oldest entries once its bytes pass the cap", function () {
        const c = viewCache({ view: 2500 });
        const a = storeView(c, "a.html", 1000);
        const b = storeView(c, "b.html", 1000);
        store(c, "blog:b1:info");
        const d = storeView(c, "d.html", 1000);

        expect(c.has(a)).toBe(false);
        expect(c.has(b)).toBe(true);
        expect(c.has(d)).toBe(true);
        expect(c.has("GET blog:b1:info")).toBe(true);
        expect(c.classStats.view.evictions).toBe(1);
      });

      it("evicts an entry bigger than the whole cap", function () {
        const c = viewCache({ view: 2500 });
        const a = storeView(c, "a.html", 1000);
        const huge = storeView(c, "huge.html", 5000);

        expect(c.has(a)).toBe(false);
        expect(c.has(huge)).toBe(false);
        expect(c.classBytes.get("view")).toBe(0);
      });

      it("stops counting the bytes of entries the cache dropped", function () {
        const c = viewCache({ view: 2500 });
        const a = storeView(c, "a.html", 1000);
        const b = storeView(c, "b.html", 1000);
        c.invalidate("template:SITE:blog:view:a.html");
        const d = storeView(c, "d.html", 1000);

        expect(c.has(a)).toBe(false);
        expect(c.has(b)).toBe(true);
        expect(c.has(d)).toBe(true);
        expect((c.classStats.view || {}).evictions || 0).toBe(0);
      });

      it("counts an entry's bytes once when its value replaces its promise", function () {
        const c = viewCache({ view: 2500 });
        const a = storeView(c, "a.html", 1000);
        c.set(a, c.createValueEntry(null, "x".repeat(1000)), [
          "template:SITE:blog:view:a.html",
        ]);
        expect(c.classBytes.get("view")).toBe(1016);
      });

      it("forgets its bytes when an entry is deleted or the cache cleared", function () {
        const c = viewCache({ view: 2500 });
        const a = storeView(c, "a.html", 1000);
        storeView(c, "b.html", 1000);
        c.delete(a);
        expect(c.classBytes.get("view")).toBe(1016);
        c.clear();
        expect(c.classBytes.size).toBe(0);
        expect(c.entryBytes.size).toBe(0);
      });
    });

    it("leaves room above the caps for the blog keys", function () {
      const createRedisClient = require("models/redis");
      const client = createRedisClient();
      const { maxEntries } = createRedisClient.getClientSideCacheStats(client);
      const capped = Object.values(Cache.CLASS_CAPS).reduce((a, b) => a + b, 0);
      expect(maxEntries - capped).toBeGreaterThanOrEqual(6000);
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
      expect(classStats.info).toEqual({
        hits: 1,
        misses: 1,
        bypass: 0,
        evictions: 0,
      });
      expect(classStats.entry).toEqual({
        hits: 0,
        misses: 0,
        bypass: 2,
        evictions: 0,
      });

      // The live stats: what the cache holds, the uncached reads and the
      // writes, each by key pattern
      const stats = createRedisClient.getClientSideCacheStats(client);
      expect(stats.classSizes.info.entries).toBe(1);
      expect(stats.classSizes.info.bytes).toBeGreaterThan(0);
      const bypass = stats.bypassPatterns.find(
        (p) => p.pattern === "GET|blog:*:entry:*"
      );
      expect(bypass.count).toBe(2);
      expect(bypass.bytes).toBeGreaterThan(0);
      const writes = stats.writePatterns.find(
        (p) => p.pattern === "SET|blog:*:entry:*"
      );
      expect(writes.count).toBe(1);

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
