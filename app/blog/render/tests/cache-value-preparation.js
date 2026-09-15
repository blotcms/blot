const { LRUCache } = require("lru-cache");
const EntryInstance = require("models/entry/instance");
const { cloneDeep, prepareCacheValue } = require("../../lib/clone");

describe("cache value preparation", function () {
  it("freezes an isolated copy while retaining EntryInstance prototypes", function () {
    const entry = new EntryInstance();
    entry.title = "Original";
    const prepared = prepareCacheValue([entry], {
      preserveEntryInstances: true,
    });

    expect(prepared.payload[0] instanceof EntryInstance).toBe(true);
    expect(Object.isFrozen(prepared.payload[0])).toBe(true);
    const response = cloneDeep(prepared.payload, {
      preserveEntryInstances: true,
    });
    response[0].title = "Changed";
    expect(prepared.payload[0].title).toBe("Original");
  });

  it("uses the envelope estimate to reject a value over the byte cap", function () {
    const cache = new LRUCache({
      maxSize: 64,
      sizeCalculation: (envelope) => envelope.size,
    });
    cache.set("large", prepareCacheValue({ body: "x".repeat(100) }));
    expect(cache.has("large")).toBe(false);
  });
});
