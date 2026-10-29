const cacheMetrics = require("../cacheMetrics");
const fetchCached = require("../fetchCached");

describe("render cache metrics", function () {
  it("scales the caps of a cache, with a floor", function () {
    const options = { max: 1000, maxSize: 100 * 1024 * 1024, ttl: 5 };

    expect(cacheMetrics.scaled(options, 1)).toBe(options);
    expect(cacheMetrics.scaled(options, 0.1)).toEqual({
      max: 100,
      maxSize: 10 * 1024 * 1024,
      ttl: 5,
    });
    expect(cacheMetrics.scaled({ max: 200, maxSize: 1024 * 1024 }, 0.01)).toEqual({
      max: 10,
      maxSize: 256 * 1024,
    });
  });

  // A key named "big" is over the 100 byte cap
  function build() {
    return cacheMetrics.createRenderCache("test", {
      max: 2,
      fetchMethod: async (key) => ({ size: key === "big" ? 200 : 1 }),
      sizeCalculation: (value) => value.size,
      maxSize: 100,
    });
  }

  it("counts hits, misses and inflight lookups and times the fill", async function () {
    const cache = build();

    const first = fetchCached(cache, "test", null, "a");
    const second = fetchCached(cache, "test", null, "a");
    await Promise.all([first, second]);
    await fetchCached(cache, "test", null, "a");

    const counters = cacheMetrics.read(cache);
    expect(counters.miss).toBe(1);
    expect(counters.inflight).toBe(1);
    expect(counters.hit).toBe(1);
    expect(counters.fills).toBe(1);
    expect(counters.uncachedFills).toBe(0);
    expect(counters.fillMs).toBeGreaterThanOrEqual(0);
  });

  it("counts evictions from size pressure, not deletes", async function () {
    const cache = build();

    await fetchCached(cache, "test", null, "a");
    await fetchCached(cache, "test", null, "b");
    await fetchCached(cache, "test", null, "c");
    expect(cacheMetrics.read(cache).evictions).toBe(1);

    cache.delete("c");
    expect(cacheMetrics.read(cache).evictions).toBe(1);
  });

  it("counts a fill the cache did not keep", async function () {
    const cache = build();

    await fetchCached(cache, "test", null, "big");

    expect(cacheMetrics.read(cache).uncachedFills).toBe(1);
  });

  it("counts an Uncacheable result as an uncached fill, not a failure", async function () {
    const { Uncacheable } = require("../uncacheableFetch");
    const cache = cacheMetrics.createRenderCache("test", {
      max: 2,
      fetchMethod: async () => {
        throw new Uncacheable([]);
      },
    });

    await fetchCached(cache, "test", null, "a").catch(() => {});

    const counters = cacheMetrics.read(cache);
    expect(counters.fills).toBe(1);
    expect(counters.uncachedFills).toBe(1);
    expect(counters.failedFills).toBe(0);
  });

  it("tells a miss on an evicted key from a cold miss", async function () {
    const cache = build();

    await fetchCached(cache, "test", null, "a");
    await fetchCached(cache, "test", null, "b");
    await fetchCached(cache, "test", null, "c"); // evicts a
    expect(cacheMetrics.read(cache).missGhost).toBe(0);
    expect(cacheMetrics.read(cache).missCold).toBe(3);

    await fetchCached(cache, "test", null, "a"); // a was evicted: a ghost
    await fetchCached(cache, "test", null, "d"); // never seen: cold

    const counters = cacheMetrics.read(cache);
    expect(counters.missGhost).toBe(1);
    expect(counters.missGhostBytes).toBe(1);
    expect(counters.missCold).toBe(4);
  });

  it("profiles evicted entries by whether they were ever hit and how long idle", async function () {
    const cache = build();

    await fetchCached(cache, "test", null, "a");
    await fetchCached(cache, "test", null, "b");
    await fetchCached(cache, "test", null, "a"); // hit
    await fetchCached(cache, "test", null, "c"); // evicts b, never hit
    await fetchCached(cache, "test", null, "d"); // evicts a, hit once

    const counters = cacheMetrics.read(cache);
    expect(counters.evictedNeverHit).toBe(1);
    expect(counters.evictedHit).toBe(1);
    expect(counters.evictedBytes).toBe(2);
    expect(counters.hitAge).toEqual([1, 0, 0, 0, 0]);
    expect(counters.evictIdle).toEqual([2, 0, 0, 0, 0]);
  });

  it("buckets the age of a hit and the idle time of an eviction", async function () {
    const cache = build();
    const realNow = Date.now;
    let offset = 0;
    Date.now = () => realNow() + offset;

    try {
      await fetchCached(cache, "test", null, "a");
      offset = 2 * 60 * 1000; // 2 minutes later
      await fetchCached(cache, "test", null, "a");
      offset = 3 * 60 * 60 * 1000; // 3 hours later
      await fetchCached(cache, "test", null, "b");
      await fetchCached(cache, "test", null, "c"); // evicts a, idle ~3h
    } finally {
      Date.now = realNow;
    }

    const counters = cacheMetrics.read(cache);
    expect(counters.hitAge).toEqual([0, 0, 1, 0, 0]);
    expect(counters.evictIdle).toEqual([0, 0, 0, 0, 1]);
  });

  it("says why a fill was not kept", async function () {
    const { Uncacheable } = require("../uncacheableFetch");
    const cache = cacheMetrics.createRenderCache("test", {
      max: 2,
      fetchMethod: async (key) => {
        if (key === "empty") throw new Uncacheable({ size: 1 });
        return { size: key === "big" ? 200 : 1 };
      },
      sizeCalculation: (value) => value.size,
      maxSize: 100,
    });

    await fetchCached(cache, "test", null, "big");
    await fetchCached(cache, "test", null, "empty").catch(() => {});
    await fetchCached(cache, "test", null, "ok");

    const counters = cacheMetrics.read(cache);
    expect(counters.uncachedFills).toBe(2);
    expect(counters.uncachedBy.oversize).toBe(1);
    expect(counters.uncachedBy.uncacheable).toBe(1);
  });

  it("uses a reason the caller gives", function () {
    const cache = build();

    cacheMetrics.fill(cache, "k", 1, { cached: false, reason: "covered" });

    expect(cacheMetrics.read(cache).uncachedBy.covered).toBe(1);
  });

  it("counts the time a request spends copying a cached value", function () {
    const cache = build();

    const result = cacheMetrics.timeClone(cache, () => "copy");

    const counters = cacheMetrics.read(cache);
    expect(result).toBe("copy");
    expect(counters.clones).toBe(1);
    expect(counters.cloneMs).toBeGreaterThanOrEqual(0);
    expect(cacheMetrics.timeClone({}, () => "copy")).toBe("copy");
  });

  it("returns counters that do not change as the cache does", async function () {
    const cache = build();
    const before = cacheMetrics.read(cache);

    await fetchCached(cache, "test", null, "a");
    await fetchCached(cache, "test", null, "a");

    expect(before.hitAge).toEqual([0, 0, 0, 0, 0]);
    expect(cacheMetrics.read(cache).hitAge).toEqual([1, 0, 0, 0, 0]);
  });

  it("ignores caches it did not build", async function () {
    expect(cacheMetrics.read({})).toBe(null);
    expect(() => cacheMetrics.count({}, "hit")).not.toThrow();
  });
});
