describe("daily update macserver", function () {
  const macserver = require("../macserver");
  const config = require("config");

  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const GB = 1024 * 1024 * 1024;
  const NOW = Date.UTC(2026, 10, 13, 7, 0);

  const stats = (overrides = {}) => ({
    disk_bytes_available: 150 * GB,
    disk_bytes_total: 200 * GB,
    icloud_bytes_available: 5 * GB,
    blogs_connected: 139,
    ...overrides,
  });
  const point = (days, gb) => ({ time: NOW - days * DAY, used: gb * GB });

  function fakeRedis(entries = {}) {
    const store = new Map(Object.entries(entries));
    return {
      store,
      sendCommand: async ([command, key, value]) =>
        command === "GET"
          ? store.has(key)
            ? store.get(key)
            : null
          : store.set(key, value) && "OK",
    };
  }

  beforeEach(function () {
    spyOn(console, "log");
  });

  describe("line", function () {
    it("gives the root disk and the iCloud quota", function () {
      const text = macserver.line(stats(), { now: NOW });

      expect(text).toBe(
        "Mac server: root disk 25% (150 GB free), iCloud 5 GB free"
      );
      expect(text).not.toContain("**");
    });

    it("projects the disk's growth to the disk warning", function () {
      // 50 GiB used, 1 GiB a day: 127 days to the 25 GB (25e9 bytes) warning
      expect(
        macserver.line(stats(), { history: [point(7, 43)], now: NOW })
      ).toContain("root disk 25% (resize in ~127 days, 150 GB free)");
      expect(
        macserver.line(stats(), { history: [point(7, 50)], now: NOW })
      ).toContain("root disk 25% (stable, 150 GB free)");
    });

    it("is bold under the warning thresholds", function () {
      const text = macserver.line(
        stats({
          disk_bytes_available: config.icloud.diskSpaceWarning - 1,
          icloud_bytes_available: config.icloud.iCloudSpaceWarning - 1,
        }),
        { now: NOW }
      );

      expect(text).toMatch(/^Mac server: \*\*root disk [^*]+\*\*, \*\*iCloud /);
    });

    it("treats an exhausted iCloud quota as low, not unknown", function () {
      expect(
        macserver.line(stats({ icloud_bytes_available: 0 }), { now: NOW })
      ).toContain("**iCloud 0 Bytes free**");
    });

    it("copes with a macserver that reports no disk size or quota", function () {
      expect(
        macserver.line(
          stats({ disk_bytes_total: undefined, icloud_bytes_available: null }),
          { now: NOW }
        )
      ).toBe("Mac server: root disk 150 GB free, iCloud quota unknown");
    });
  });

  describe("memory and CPU", function () {
    const reported = (overrides = {}) =>
      stats({
        cpu_percent: 195,
        cpu_percent_average: 192,
        cpu_count: 4,
        load_average: 3.04,
        memory_rss_bytes: 298 * 1024 * 1024,
        host_memory_free_bytes: 0.01 * GB,
        host_memory_available_bytes: 6 * GB,
        host_memory_total_bytes: 16 * GB,
        uptime_seconds: 26 * 60 * 60,
        ...overrides,
      });

    it("join the line after iCloud", function () {
      expect(macserver.line(reported(), { now: NOW })).toBe(
        "Mac server: root disk 25% (150 GB free), iCloud 5 GB free, memory 63% (6 GB free), CPU 195% (192% over 26h)"
      );
    });

    it("bolds memory under 15% available", function () {
      expect(
        macserver.line(reported({ host_memory_available_bytes: 2 * GB }), {
          now: NOW,
        })
      ).toContain("**memory 88% (2 GB free)**");
    });

    it("leave memory out when only the kernel's free pages are reported", function () {
      const text = macserver.line(
        reported({ host_memory_available_bytes: undefined }),
        { now: NOW }
      );

      expect(text).not.toContain("memory");
      expect(text).toContain("iCloud 5 GB free, CPU 195%");
    });

    it("are left out by a macserver that doesn't report them", function () {
      expect(macserver.line(stats(), { now: NOW })).not.toMatch(/memory|CPU/);
    });
  });

  describe("main", function () {
    it("stores today's disk reading", async function () {
      const client = fakeRedis();
      const res = await macserver({
        fetchStats: async () => stats(),
        client,
        now: NOW,
      });

      expect(res.macserver).toContain("root disk 25%");
      expect(JSON.parse(client.store.get(macserver.HISTORY_KEY))).toEqual([
        { time: NOW, used: 50 * GB },
      ]);
    });

    it("says the macserver is unreachable when /stats fails", async function () {
      const res = await macserver({
        fetchStats: async () => {
          throw new Error("HTTP error: 502 - Bad Gateway");
        },
        client: fakeRedis(),
        now: NOW,
      });

      expect(res.macserver).toBe(
        "Mac server: **unreachable** (HTTP error: 502 - Bad Gateway)"
      );
    });

    it("still gives the figures when Redis fails", async function () {
      const res = await macserver({
        fetchStats: async () => stats(),
        client: {
          sendCommand: async () => {
            throw new Error("Redis down");
          },
        },
        now: NOW,
      });

      expect(res.macserver).toBe(
        "Mac server: root disk 25% (150 GB free), iCloud 5 GB free"
      );
    });
  });
});
