const { LRUCache } = require("lru-cache");
const { prepareCacheValue } = require("models/cache/clone");
const heapEstimate = require("models/cache/heapEstimate");

function walk(value) {
  const walker = heapEstimate.walk(value);
  let step;
  do step = walker.next();
  while (!step.done);
  return step.value;
}

describe("heapEstimate", function () {
  it("counts a string with a character above U+00FF at two bytes a character", function () {
    const ascii = walk({ body: "x".repeat(1000) });
    const twoByte = walk({ body: "x".repeat(999) + "“" });

    expect(twoByte.heap - ascii.heap).toBeGreaterThan(900);
    expect(twoByte.twoByteBytes).toBeGreaterThanOrEqual(2000);
    expect(ascii.twoByteBytes).toBe(0);
  });

  it("counts objects with many keys as wide", function () {
    const keys = (n) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => ["k" + i, true]));

    expect(walk([keys(10)]).wideObjects).toBe(0);
    expect(walk([keys(30), keys(30)]).wideObjects).toBe(2);
  });

  it("counts a shared object once", function () {
    const shared = { body: "x".repeat(1000) };
    const once = walk([{ link: shared }]);
    const many = walk([{ link: shared }, { link: shared }, { link: shared }]);

    expect(many.heap - once.heap).toBeLessThan(300);
  });

  it("measures a cache's values in the background and extrapolates the rest", async function () {
    const cache = new LRUCache({
      max: 10,
      maxSize: 1e6,
      sizeCalculation: (envelope) => envelope.size,
    });
    heapEstimate.track(cache);
    cache.set("a", prepareCacheValue({ body: "x".repeat(999) + "“" }));

    expect(heapEstimate.estimate(cache).heapBytes).toBe(0);
    await heapEstimate.measureSome();

    const estimate = heapEstimate.estimate(cache);
    expect(estimate.measuredShare).toBe(1);
    expect(estimate.heapBytes).toBeGreaterThan(cache.calculatedSize);
    expect(estimate.twoByteBytes).toBeGreaterThanOrEqual(2000);
  });
});
