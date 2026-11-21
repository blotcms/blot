const { LRUCache } = require("lru-cache");
const EntryInstance = require("models/entry/instance");
const { cloneDeep, prepareCacheValue } = require("models/cache/clone");

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

  it("copies and counts an object reachable from several places once", function () {
    const shared = { body: "x".repeat(1000) };
    const once = prepareCacheValue([{ link: shared }]);
    const many = prepareCacheValue([
      { link: shared },
      { link: shared },
      { link: shared },
    ]);

    expect(many.payload[0].link).toBe(many.payload[2].link);
    expect(many.payload[0].link).not.toBe(shared);
    expect(Object.isFrozen(many.payload[0].link)).toBe(true);
    // Each extra reference costs its own container, not another 1000 bytes.
    expect(many.size - once.size).toBeLessThan(200);
  });

  it("estimates V8's heap beside the size the caps use", function () {
    const ascii = prepareCacheValue({ body: "x".repeat(1000) });
    const twoByte = prepareCacheValue({ body: "x".repeat(999) + "\u201c" });

    // One character above U+00FF makes V8 store the whole string as UTF-16
    expect(twoByte.heapBytes - ascii.heapBytes).toBeGreaterThan(900);
    expect(twoByte.twoByteBytes).toBeGreaterThanOrEqual(2000);
    expect(ascii.twoByteBytes).toBe(0);
    // size, which the caps use, is unchanged by this
    expect(twoByte.size - ascii.size).toBeLessThan(10);
  });

  it("counts an object with many keys at V8's dictionary-mode cost", function () {
    const keys = (n) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => ["k" + i, true]));
    const fast = prepareCacheValue(keys(10));
    const slow = prepareCacheValue(keys(30));

    expect(fast.heapBytes).toBeLessThan(300);
    expect(slow.heapBytes).toBeGreaterThan(1500);
  });

  it("counts a shared object's heap once", function () {
    const shared = { body: "x".repeat(1000) };
    const once = prepareCacheValue([{ link: shared }]);
    const many = prepareCacheValue([
      { link: shared },
      { link: shared },
      { link: shared },
    ]);

    expect(many.heapBytes - once.heapBytes).toBeLessThan(300);
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

describe("warnIfTooLargeToCache", function () {
  const { warnIfTooLargeToCache } = require("../load/augmentedEntries");

  let uniqueBlog = 0;

  // The warnings are remembered for the life of the process, so each test
  // uses a blog id no other test has.
  function makeReq(cacheID) {
    return {
      blog: { id: "warn-blog-" + process.pid + "-" + uniqueBlog, cacheID },
    };
  }

  beforeEach(function () {
    uniqueBlog++;
    spyOn(console, "warn");
  });

  const cache = { maxSize: 10 };
  const tooLarge = { size: cache.maxSize + 1 };

  it("warns once per blog and cacheID, however many times a fill is over the cap", function () {
    const req = makeReq(100);

    warnIfTooLargeToCache("allEntries", req, tooLarge, cache);
    warnIfTooLargeToCache("allEntries", req, tooLarge, cache);

    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn.calls.argsFor(0)[0]).toContain("allEntries cache");
    expect(console.warn.calls.argsFor(0)[0]).toContain(req.blog.id);
  });

  it("warns again when the cacheID changes", function () {
    const req = makeReq(100);

    warnIfTooLargeToCache("allEntries", req, tooLarge, cache);
    warnIfTooLargeToCache("allEntries", req, tooLarge, cache);
    warnIfTooLargeToCache(
      "allEntries",
      { blog: { id: req.blog.id, cacheID: 101 } },
      tooLarge,
      cache
    );

    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it("warns separately for each cache name", function () {
    const req = makeReq(100);

    warnIfTooLargeToCache("allEntries", req, tooLarge, cache);
    warnIfTooLargeToCache("archives", req, tooLarge, cache);

    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it("does not warn for a value within the cap", function () {
    warnIfTooLargeToCache("allEntries", makeReq(100), { size: 10 }, cache);

    expect(console.warn).not.toHaveBeenCalled();
  });
});
