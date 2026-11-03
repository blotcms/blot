describe("scripts/storage/folder-soak-report", function () {
  var { summarise } = require("../shadow-report");
  var report = require("../folder-soak-report");

  // Synthetic counters: 200 sampled reads (100 hits, 80 misses, 20 direct),
  // 400 stats, a serve with a first-byte time
  function counters() {
    return {
      "read:sampled": 200,
      "read:matched": 200,
      "read:local:le:1": 200,
      "read:s3:le:1": 100,
      "read:s3:le:100": 100,
      "read:s3:hit:le:1": 100,
      "read:s3:miss:le:100": 80,
      "read:s3:direct:le:100": 20,
      "stat:sampled": 400,
      "stat:matched": 400,
      "stat:local:le:1": 400,
      "stat:s3:le:1": 400,
      "serve:sampled": 10,
      "serve:matched": 10,
      "serve:local:le:1": 10,
      "serve:s3:le:100": 10,
      "serve:s3:miss:le:100": 10,
      "serve:local:ttfb:le:1": 10,
      "serve:s3:ttfb:le:50": 10,
      "cache:filled": 480,
    };
  }

  it("estimates S3 requests per call from the cache outcomes", function () {
    var summary = summarise(counters());

    expect(report.requestsPerOp(summary.ops.read)).toEqual(0.5);
    expect(report.requestsPerOp(summary.ops.serve)).toEqual(1);
    expect(report.requestsPerOp(summary.ops.stat)).toBeNull();
  });

  it("formats the operation tables", function () {
    var text = report.operationsMarkdown(summarise(counters())).join("\n");

    expect(text).toContain("| Operation | Disk p50 / p95 (ms) | S3 p50 / p95 (ms) | S3 requests per call (estimated) | n |");
    expect(text).toContain("| `read` | <=1 / <=1 | <=1 / <=100 | 0.50 | 200 |");
    expect(text).toContain("| `stat` | <=1 / <=1 | <=1 / <=1 | 0 | 400 |");
    expect(text).toContain("| `read` | <=1 / <=1 (n 100) | <=100 / <=100 (n 80) | <=100 / <=100 (n 20) |");
    expect(text).toContain("| `serve` | <=1 / <=1 | <=50 / <=50 |");
  });

  it("costs S3 as a share of the data volume", function () {
    var summary = summarise(counters());
    var cost = report.costEstimate(
      summary,
      10,
      { rate: 0.1, ebsGb: 100, ebsPrice: 0.1, s3GbMonth: 0.02, s3Put: 0.01, s3Get: 0.001 },
      50 * 1024 * 1024 * 1024
    );

    // 50 GiB at 0.02, against 100 GB at 0.1
    expect(cost.storage).toBeCloseTo(1, 6);
    // 480 fills in 10 hours: 1152 a day, 29.2 a month in thousands
    expect(cost.writesPerDay).toBeCloseTo(1152, 6);
    expect(cost.putsPerMonth).toBeCloseTo(1152 * (730 / 24), 6);
    // read and serve: (200 + 10) sampled / 0.1 / 10 h * 730
    expect(cost.readsPerMonth).toBeCloseTo(153300, 3);
    // half the reads miss or go direct, every serve does
    expect(cost.getsPerMonth).toBeCloseTo(80300, 3);
    expect(cost.total).toBeCloseTo(cost.storage + cost.requests, 9);
    expect(cost.percentOfEbs).toBeCloseTo((cost.total / 10) * 100, 9);

    var text = report.costMarkdown(cost).join("\n");

    expect(text).toContain("as % of the data volume's monthly cost | about ");
    expect(text).toContain("| Egress | unchanged");
  });

  it("says what is missing when the volume is not given", function () {
    var cost = report.costEstimate(summarise(counters()), 10, { rate: 0.1, writesPerDay: 100 }, 1024 * 1024 * 1024);

    expect(cost.writesFrom).toEqual("from --writes-per-day");
    expect(report.costMarkdown(cost).join("\n")).toContain("give --ebs-gb and --ebs-price-gb-month");
  });

  describe("unit memory", function () {
    var MB = 1024 * 1024;

    function line(time, name, anon, shmem) {
      return time + " name=" + name + " anon=" + anon * MB + " file=1 shmem=" + shmem * MB + " limit=0 oom_kill=0 node_max=1 top=-:0";
    }

    it("parses a log line and skips the others", function () {
      expect(report.parseUnitMemLine(line("2026-10-30T07:20:15Z", "blot-blue", 100, 5))).toEqual({
        time: Date.parse("2026-10-30T07:20:15Z"),
        name: "blot-blue",
        held: 105 * MB,
      });
      expect(report.parseUnitMemLine("2026-10-30T07:20:15Z name=host mem_available=1 mem_total=2 swap_used=0")).toBeNull();
      expect(report.parseUnitMemLine("")).toBeNull();
      expect(report.parseUnitMemLine("garbage line here")).toBeNull();
      expect(report.parseUnitMemLine("2026-10-30T07:20:15Z name=blot-blue anon=x shmem=1")).toBeNull();
    });

    it("takes the nearest-rank percentile", function () {
      var values = [];
      for (var i = 1; i <= 100; i++) values.push(i);

      expect(report.nearestRank(values.reverse(), 0.95)).toEqual(95);
      expect(report.nearestRank([], 0.95)).toBeNull();
    });

    it("gives p95 per unit for each window", async function () {
      var lines = [];

      for (var i = 1; i <= 20; i++) {
        lines.push(line("2026-10-30T00:" + (i < 10 ? "0" : "") + i + ":00Z", "blot-blue", i, 0));
        lines.push(line("2026-11-02T00:" + (i < 10 ? "0" : "") + i + ":00Z", "blot-blue", i * 2, 0));
      }

      lines.push("2026-10-30T00:05:00Z name=host mem_available=1 mem_total=2 swap_used=0");
      lines.push(line("2026-10-30T00:05:00Z", "blot-green", 7, 1));

      var result = await report.unitMemory(lines, {
        before: { from: new Date("2026-10-30T00:00:00Z"), to: new Date("2026-10-31T00:00:00Z") },
        soak: { from: new Date("2026-11-02T00:00:00Z"), to: new Date("2026-11-03T00:00:00Z") },
      });

      expect(result["blot-blue"].before).toEqual({ p95: 19 * MB, samples: 20 });
      expect(result["blot-blue"].soak).toEqual({ p95: 38 * MB, samples: 20 });
      expect(result["blot-green"].before).toEqual({ p95: 8 * MB, samples: 1 });
      expect(result["blot-green"].soak).toEqual({ p95: null, samples: 0 });
      expect(Object.keys(result)).toEqual(["blot-blue", "blot-green"]);

      var text = report.memoryMarkdown(result).join("\n");

      expect(text).toContain("| `blot-blue` | 19 MiB | 38 MiB | +100% | 20 / 20 |");
      expect(text).toContain("| `blot-green` | 8 MiB | - | - | 1 / 0 |");
    });
  });

  describe("index memory", function () {
    // A fake Redis: 10 dir hashes of 1000 bytes, 4 names sets of 500 bytes,
    // one totals hash, and a key of another type under the dir name
    function fakeClient() {
      var keys = [];
      var types = {};
      var sizes = {};
      var calls = [];

      for (var i = 0; i < 10; i++) {
        keys.push("blog:b1:file:dir:/d" + i);
        types[keys[keys.length - 1]] = "hash";
        sizes[keys[keys.length - 1]] = 1000;
      }

      for (i = 0; i < 4; i++) {
        keys.push("blog:b1:file:names:/d" + i);
        types[keys[keys.length - 1]] = "zset";
        sizes[keys[keys.length - 1]] = 500;
      }

      keys.push("blog:b1:file:totals");
      types["blog:b1:file:totals"] = "hash";
      sizes["blog:b1:file:totals"] = 100;
      keys.push("blog:b1:file:dir:/odd");
      types["blog:b1:file:dir:/odd"] = "string";
      sizes["blog:b1:file:dir:/odd"] = 99999;
      keys.push("blog:b1:other");

      return {
        calls: calls,
        sendCommand: function (args) {
          calls.push(args[0]);

          if (args[0] === "SCAN") {
            // two pages
            return Promise.resolve(args[1] === "0" ? ["7", keys.slice(0, 8)] : ["0", keys.slice(8)]);
          }

          if (args[0] === "TYPE") return Promise.resolve(types[args[1]]);
          if (args[0] === "MEMORY") return Promise.resolve(sizes[args[2]]);
          if (args[0] === "HGET") return Promise.resolve("2048");

          return Promise.reject(new Error("unexpected " + args[0]));
        },
      };
    }

    it("extrapolates from a sample, checking TYPE first, and only reads", async function () {
      var client = fakeClient();
      var index = await report.estimateIndexMemory(client, { sample: 2000, scanCount: 1000, maxScanCalls: 10 });

      expect(index.complete).toBe(true);
      expect(index.kinds.dir.keys).toEqual(11);
      expect(index.kinds.names.keys).toEqual(4);
      expect(index.kinds.totals.keys).toEqual(1);
      // everything fits in the sample, so the odd key is measured as a miss
      expect(index.wrongType).toEqual(1);
      expect(index.kinds.dir.sampled).toEqual(10);
      expect(index.kinds.dir.bytes).toBeCloseTo(11000, 6);
      expect(index.bytes).toBeCloseTo(11000 + 2000 + 100, 6);
      expect(index.margin).toEqual(0);
      expect(index.storedBytes).toEqual(2048);
      expect(index.memoryCalls).toEqual(15);

      var allowed = ["SCAN", "TYPE", "MEMORY", "HGET"];
      expect(client.calls.every((c) => allowed.indexOf(c) !== -1)).toBe(true);
      expect(client.calls.indexOf("TYPE")).toBeLessThan(client.calls.indexOf("MEMORY"));
    });

    it("limits the sample and the scan", async function () {
      var index = await report.estimateIndexMemory(fakeClient(), { sample: 5, scanCount: 1000, maxScanCalls: 1 });

      expect(index.complete).toBe(false);
      expect(index.scanCalls).toEqual(1);
      expect(index.memoryCalls).toBeLessThan(6);
      expect(report.indexMarkdown(index).join("\n")).toContain("stopped early");
    });

    it("names the kind of a key", function () {
      expect(report.kindOf("blog:abc:file:dir:/a:b")).toEqual("dir");
      expect(report.kindOf("blog:abc:file:paths")).toEqual("paths");
      expect(report.kindOf("blog:abc:entry:x")).toBeNull();
    });
  });

  it("reads the arguments", function () {
    var options = report.parseArgs(["--hours", "72", "--rate", "0.01", "--unit-mem", "x.log", "--before", "2026-10-30T00:00:00Z/2026-11-01T00:00:00Z"]);

    expect(options.hours).toEqual(72);
    expect(options.rate).toEqual(0.01);
    expect(options.before.to).toEqual(new Date("2026-11-01T00:00:00Z"));
    expect(function () { report.parseArgs(["--hours", "2", "--since", "2026-11-01"]); }).toThrow();
    expect(function () { report.parseArgs(["--unit-mem", "x.log"]); }).toThrow();
    expect(function () { report.parseArgs(["--nope"]); }).toThrow();
  });
});
