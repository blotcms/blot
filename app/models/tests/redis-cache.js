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
    expect(Cache.classifyKeys(["blog:x:info", "blog:x:entry:/a"])).toEqual({
      cache: false,
      className: "entry",
    });
  });

  it("opts in to tracking", function () {
    expect(new Cache({ ttl: 0, maxEntries: 10, evictPolicy: "LRU" }).trackingOn())
      .toEqual(["CLIENT", "TRACKING", "ON", "OPTIN"]);
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
      expect(classStats.info).toEqual({ hits: 1, misses: 1, bypass: 0 });
      expect(classStats.entry).toEqual({ hits: 0, misses: 0, bypass: 2 });

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
