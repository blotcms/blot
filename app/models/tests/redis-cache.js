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
      // before the read, so a write must invalidate the cached value. Redis
      // pushes the invalidation on this connection ahead of the SET reply.
      await client.set(id + ":info", "c");
      expect(await client.get(id + ":info")).toBe("c");
    } finally {
      await client.del([id + ":info", id + ":entry:/a"]);
      await client.quit();
    }
  });
});
