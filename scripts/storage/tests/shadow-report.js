describe("scripts/storage/shadow-report", function () {
  var shadow = require("storage/folder/shadow");
  var { keysFor, sum, percentile, summarise, format } = require("../shadow-report");

  it("names one key per hour, oldest first, ending with this hour", function () {
    var now = new Date("2026-11-02T13:30:00Z");

    expect(keysFor(3, now)).toEqual([
      shadow.KEY_PREFIX + "2026110211",
      shadow.KEY_PREFIX + "2026110212",
      shadow.KEY_PREFIX + "2026110213",
    ]);
  });

  it("adds hashes up field by field", function () {
    expect(sum([{ a: "1", b: "2" }, null, { a: "3" }])).toEqual({ a: 4, b: 2 });
  });

  it("reads percentiles from the histogram's bounds", function () {
    var histogram = { 1: 50, 10: 45, 100: 4, inf: 1 };

    expect(percentile(histogram, 0.5)).toEqual("1");
    expect(percentile(histogram, 0.95)).toEqual("10");
    expect(percentile(histogram, 0.99)).toEqual("100");
    expect(percentile(histogram, 1)).toEqual("inf");
    expect(percentile({}, 0.5)).toBeNull();
  });

  it("summarises each call and the cache", function () {
    var summary = summarise({
      "read:sampled": 200,
      "read:matched": 196,
      "read:mismatched": 2,
      "read:mismatch:bytes": 1,
      "read:mismatch:missing-in-s3": 1,
      "read:transient": 2,
      "read:transient:bytes": 2,
      "read:s3error": 1,
      "read:s3error:TimeoutError": 1,
      "read:dropped": 5,
      "read:local:le:1": 190,
      "read:local:le:5": 10,
      "read:s3:le:20": 150,
      "read:s3:le:100": 49,
      "read:s3:le:inf": 1,
      "cache:hits": 150,
      "cache:misses": 50,
      "cache:fetchedBytes": 1024 * 1024,
    });

    expect(Object.keys(summary.ops)).toEqual(["read"]);
    expect(summary.ops.read.mismatchRate).toEqual(0.01);
    expect(summary.ops.read.mismatchKinds).toEqual({ bytes: 1, "missing-in-s3": 1 });
    expect(summary.ops.read.transientKinds).toEqual({ bytes: 2 });
    expect(summary.ops.read.s3errorCodes).toEqual({ TimeoutError: 1 });
    expect(summary.ops.read.dropped).toEqual(5);
    expect(summary.ops.read.local).toEqual({ p50: "1", p95: "1", p99: "5" });
    expect(summary.ops.read.s3).toEqual({ p50: "20", p95: "100", p99: "100" });
    expect(summary.cache.hitRate).toEqual(0.75);

    var text = format(Object.assign({ hours: 24, from: "a", to: "b" }, summary));

    expect(text).toContain("1.00%");
    expect(text).toContain("<=20 / <=100 / <=100");
    expect(text).toContain("read mismatch: bytes 1, missing-in-s3 1");
    expect(text).toContain("75.00% hits");
  });

  it("says so when nothing was sampled", function () {
    var summary = summarise({});

    expect(format(Object.assign({ hours: 1, from: "a", to: "b" }, summary))).toContain("Nothing sampled");
  });
});
