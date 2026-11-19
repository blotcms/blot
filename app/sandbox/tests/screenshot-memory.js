describe("sandbox screenshot memory watchdog", function () {
  const memory = require("../jobs/screenshot-memory");
  const { capture, pageFailure, TooHeavyError } = require("../jobs/screenshot");

  const MiB = 1024 * 1024;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // A file system of { path: text } for the meter to read
  const fakeIO = (files, dirs = {}) => ({
    readFile: async (file) => {
      if (!(file in files)) throw new Error("ENOENT");
      return String(files[file]);
    },
    readdir: async (dir) => {
      if (!(dir in dirs)) throw new Error("ENOENT");
      return dirs[dir];
    },
  });

  describe("createMeter", function () {
    it("reads the cgroup, and judges a page at 85% of its limit", async function () {
      const meter = await memory.createMeter({
        dirs: ["/missing", "/cg"],
        io: fakeIO({
          "/cg/memory.current": "1000\n",
          "/cg/memory.max": String(512 * MiB),
        }),
      });
      expect(meter.source).toBe("cgroup");
      expect(meter.threshold).toBe(Math.floor(512 * MiB * 0.85));
      expect(await meter.read()).toBe(1000);
    });

    it("uses the fixed threshold when the cgroup has no limit", async function () {
      const meter = await memory.createMeter({
        dirs: ["/cg"],
        io: fakeIO({ "/cg/memory.current": "5", "/cg/memory.max": "max" }),
      });
      expect(meter.source).toBe("cgroup");
      expect(meter.threshold).toBe(430 * MiB);
    });

    it("sums the resident memory of the process and what it started when the cgroup is out of sight", async function () {
      const stat = (ppid) => `x (a b) S ${ppid} 1 1 0`;
      const pages = (n) => `100 ${n} 0 0 0 0 0`;
      const meter = await memory.createMeter({
        dirs: ["/nowhere"],
        pid: 10,
        io: fakeIO(
          {
            "/proc/10/stat": stat(1),
            "/proc/10/statm": pages(10),
            "/proc/11/stat": stat(10), // chromium
            "/proc/11/statm": pages(100),
            "/proc/12/stat": stat(11), // its renderer
            "/proc/12/statm": pages(1000),
            "/proc/99/stat": stat(1), // somebody else's
            "/proc/99/statm": pages(5000),
          },
          { "/proc": ["10", "11", "12", "99", "self", "meminfo"] }
        ),
      });
      expect(meter.source).toBe("proc");
      expect(meter.threshold).toBe(430 * MiB);
      expect(await meter.read()).toBe(1110 * 4096);
    });
  });

  describe("watch", function () {
    const meterOf = (readings, threshold = 100) => ({
      threshold,
      read: async () => (readings.length > 1 ? readings.shift() : readings[0]),
    });

    it("calls back once, with the reading that passed the threshold", async function () {
      const seen = [];
      const watcher = memory.watch(
        meterOf([10, 50, 120, 200]),
        (bytes) => seen.push(bytes),
        { pollMs: 1 }
      );
      await wait(60);
      watcher.stop();
      expect(seen).toEqual([120]);
      expect(watcher.peak()).toBe(120);
    });

    it("stays quiet below the threshold and once stopped", async function () {
      const seen = [];
      const readings = [10];
      const watcher = memory.watch(
        meterOf(readings),
        (bytes) => seen.push(bytes),
        { pollMs: 1 }
      );
      await wait(20);
      watcher.stop();
      readings[0] = 500;
      await wait(20);
      expect(seen).toEqual([]);
    });

    it("skips a reading that fails", async function () {
      const seen = [];
      let calls = 0;
      const watcher = memory.watch(
        {
          threshold: 100,
          read: async () => {
            if (++calls < 3) throw new Error("gone");
            return 150;
          },
        },
        (bytes) => seen.push(bytes),
        { pollMs: 1 }
      );
      await wait(60);
      watcher.stop();
      expect(seen).toEqual([150]);
    });
  });

  describe("capture", function () {
    // A browser whose page never finishes loading
    const hangingBrowser = () => {
      const closed = { count: 0 };
      const context = {
        close: async () => closed.count++,
        newPage: () => new Promise(() => {}),
      };
      return { closed, browser: { createBrowserContext: async () => context } };
    };

    it("gives up on a page that takes the memory past the threshold, closing its context", async function () {
      const { browser, closed } = hangingBrowser();
      const meter = { threshold: 100, read: async () => 120 };

      let error;
      try {
        await capture(
          browser,
          {},
          { url: "https://heavy.example/a?secret=1" },
          meter
        );
      } catch (e) {
        error = e;
      }

      expect(error instanceof TooHeavyError).toBe(true);
      expect(error.bytes).toBe(120);
      expect(closed.count).toBeGreaterThan(0);
    });

    it("reports it as a final failure with the host and not the query", function () {
      const failure = pageFailure(
        new TooHeavyError(450 * MiB),
        {},
        "https://heavy.example:8080/a?secret=1"
      );
      expect(failure).toEqual({
        error: "the page needed more memory than the browser has",
        retryable: false,
        tooHeavy: true,
        host: "heavy.example:8080",
        peakBytes: 450 * MiB,
      });
    });
  });
});
