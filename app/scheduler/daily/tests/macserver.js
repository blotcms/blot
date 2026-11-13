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
    it("gives the root disk, the iCloud quota and the sites", function () {
      const text = macserver.line(stats(), { now: NOW });

      expect(text).toBe(
        "macserver: root disk 25% (150 GB free), iCloud 5 GB free, 139 sites"
      );
      expect(text).not.toContain("**");
    });

    it("projects the disk's growth to a full disk", function () {
      expect(
        macserver.line(stats(), { history: [point(7, 43)], now: NOW })
      ).toContain("root disk 25% (full in ~150 days, 150 GB free)");
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

      expect(text).toMatch(/^macserver: \*\*root disk [^*]+\*\*, \*\*iCloud /);
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
      ).toBe(
        "macserver: root disk 150 GB free, iCloud quota unknown, 139 sites"
      );
    });
  });

  describe("processLine", function () {
    const reported = (overrides = {}) =>
      stats({
        cpu_percent: 152,
        cpu_percent_average: 160,
        cpu_count: 4,
        load_average: 4.83,
        memory_rss_bytes: 280 * 1024 * 1024,
        host_memory_free_bytes: 4.72 * GB,
        host_memory_total_bytes: 8 * GB,
        uptime_seconds: 7 * 24 * 60 * 60,
        ...overrides,
      });

    it("gives the process's CPU and memory and the host's load and memory", function () {
      expect(macserver.processLine(reported())).toBe(
        "macserver process: CPU 152% (160% over 7d), memory 280 MB; host load 4.8 on 4 cores, memory 59% free"
      );
    });

    it("is left out by a macserver that doesn't report them", function () {
      expect(macserver.processLine(stats())).toBe(null);
    });

    it("is part of the view", async function () {
      const res = await macserver({
        fetchStats: async () => reported(),
        client: fakeRedis(),
        now: NOW,
      });

      expect(res.macserver_process).toContain("CPU 152%");
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
        "macserver: **unreachable** (HTTP error: 502 - Bad Gateway)"
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
        "macserver: root disk 25% (150 GB free), iCloud 5 GB free, 139 sites"
      );
    });
  });
});
