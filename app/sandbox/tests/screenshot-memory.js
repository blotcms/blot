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

  describe("the threshold", function () {
    it("is 85% of the limit the broker passed in", function () {
      const meter = memory.createMeter({
        env: { BLOT_BROWSER_MEMORY_MAX: String(512 * MiB) },
        io: fakeIO({}),
      });
      expect(meter.threshold).toBe(Math.floor(512 * MiB * 0.85));
    });

    it("is the fixed 430 MiB when it is absent, unlimited or not a number", function () {
      for (const value of [undefined, "", "max", "-1", "0", "5 MiB"]) {
        expect(memory.thresholdFrom(value)).toBe(430 * MiB);
      }
    });
  });

  describe("the meter", function () {
    const stat = (ppid) => `x (a b) S ${ppid} 1 1 0`;
    const pages = (n) => `100 ${n} 0 0 0 0 0`;
    const rollup = (kb) =>
      `00400000-ff Rollup\nRss: ${kb * 2} kB\nPss: ${kb} kB\n`;
    const browser = "0::/blot-sandbox/blue-browser\n";

    it("sums the PSS of the processes in the browser cgroup, whatever pid the job has", async function () {
      const meter = memory.createMeter({
        pid: 7, // the jail's own numbering: not in /proc
        env: {},
        io: fakeIO(
          {
            "/proc/10/stat": stat(1),
            "/proc/10/cgroup": browser,
            "/proc/10/smaps_rollup": rollup(100),
            "/proc/11/stat": stat(10),
            "/proc/11/cgroup": browser,
            "/proc/11/smaps_rollup": rollup(2000),
            "/proc/99/stat": stat(1),
            "/proc/99/cgroup": "0::/system.slice/other\n",
            "/proc/99/smaps_rollup": rollup(50000),
          },
          { "/proc": ["10", "11", "99", "self", "meminfo"] }
        ),
      });
      expect(await meter.read()).toBe(2100 * 1024);
      expect(meter.source).toBe("pss");
    });

    it("falls back to the descendants of its own pid when no process is in that cgroup", async function () {
      const meter = memory.createMeter({
        pid: 10,
        env: {},
        io: fakeIO(
          {
            "/proc/10/stat": stat(1),
            "/proc/10/smaps_rollup": rollup(10),
            "/proc/12/stat": stat(10),
            "/proc/12/smaps_rollup": rollup(20),
            "/proc/99/stat": stat(1),
            "/proc/99/smaps_rollup": rollup(5000),
          },
          { "/proc": ["10", "12", "99"] }
        ),
      });
      expect(await meter.read()).toBe(30 * 1024);
    });

    it("uses RSS for a process whose smaps_rollup can't be read, and says so", async function () {
      const meter = memory.createMeter({
        env: {},
        io: fakeIO(
          {
            "/proc/10/stat": stat(1),
            "/proc/10/cgroup": browser,
            "/proc/10/smaps_rollup": rollup(100),
            "/proc/11/stat": stat(10),
            "/proc/11/cgroup": browser,
            "/proc/11/statm": pages(1000),
          },
          { "/proc": ["10", "11"] }
        ),
      });
      expect(await meter.read()).toBe(100 * 1024 + 1000 * 4096);
      expect(meter.source).toBe("rss");
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
      const meter = { threshold: 100, source: "pss", read: async () => 120 };

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
        new TooHeavyError(450 * MiB, "pss"),
        {},
        "https://heavy.example:8080/a?secret=1"
      );
      expect(failure).toEqual({
        error: "the page needed more memory than the browser has",
        retryable: false,
        tooHeavy: true,
        host: "heavy.example:8080",
        peakBytes: 450 * MiB,
        meter: "pss",
      });
    });
  });
});
