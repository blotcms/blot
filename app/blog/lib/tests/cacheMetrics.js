const cacheMetrics = require("../cacheMetrics");
const fetchCached = require("../fetchCached");

describe("render cache metrics", function () {
  function build(options = {}) {
    return cacheMetrics.createRenderCache("test", {
      max: 2,
      fetchMethod: async (key) => ({ size: 1, value: key }),
      sizeCalculation: (value) => value.size,
      maxSize: options.maxSize || 100,
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
    const cache = build({ maxSize: 0.5 });

    await fetchCached(cache, "test", null, "a");

    expect(cacheMetrics.read(cache).uncachedFills).toBe(1);
  });

  it("ignores caches it did not build", async function () {
    expect(cacheMetrics.read({})).toBe(null);
    expect(() => cacheMetrics.count({}, "hit")).not.toThrow();
  });
});
