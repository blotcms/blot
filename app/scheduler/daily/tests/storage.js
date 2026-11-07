describe("daily update storage", function () {
  const storage = require("../storage");
  const { STORAGE_OFFSITE_KEY } = require("../../check-redis-host");

  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const GB = 1024 * 1024 * 1024;
  const NOW = Date.UTC(2026, 9, 22, 7, 0);

  const stamp = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
  // A value as config/storage-bucket/bin/offsite-sync.sh stores it
  const copyLine = ({ age = 9 * HOUR, objects = 1234567, bytes = 2e12 } = {}) =>
    `${stamp(NOW - age)} ${objects} ${bytes}`;
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

  const run = (deps) => storage(deps);

  describe("line", function () {
    it("gives the size, objects and age of the last copy", function () {
      const text = storage.line(copyLine(), { now: NOW });

      expect(text).toBe("Storage: 1.8 TB (1,234,567 objects), offsite 9h ago");
      expect(text).not.toContain("**");
    });

    it("adds the growth over the last week", function () {
      const bytes = 100 * GB;
      const value = copyLine({ bytes, age: 0 });

      expect(storage.line(value, { history: [point(7, 88)], now: NOW })).toBe(
        "Storage: 100 GB (+12 GB this week, 1,234,567 objects), offsite 0m ago"
      );
      expect(
        storage.line(value, { history: [point(7, 104)], now: NOW })
      ).toContain("(-4 GB this week, ");
      expect(
        storage.line(value, { history: [point(7, 100)], now: NOW })
      ).toContain("(no change this week, ");
    });

    it("says how long the growth covers when under a week", function () {
      const value = copyLine({ bytes: 100 * GB, age: 0 });

      expect(
        storage.line(value, { history: [point(2, 94)], now: NOW })
      ).toContain("(+6 GB in 2d, ");
    });

    it("leaves the growth out with under a day of history, or only older readings", function () {
      const value = copyLine({ bytes: 100 * GB, age: 0 });

      expect(storage.line(value, { history: [], now: NOW })).toContain(
        "GB (1,234,567 objects)"
      );
      expect(
        storage.line(value, {
          history: [{ time: NOW - 5 * HOUR, used: 90 * GB }],
          now: NOW,
        })
      ).toContain("GB (1,234,567 objects)");
      expect(
        storage.line(value, { history: [point(20, 50)], now: NOW })
      ).toContain("GB (1,234,567 objects)");
    });

    it("flags the copy after two days", function () {
      expect(storage.line(copyLine({ age: 2 * DAY }), { now: NOW })).toBe(
        "Storage: 1.8 TB (1,234,567 objects), offsite 2d ago"
      );
      expect(storage.line(copyLine({ age: 3 * DAY }), { now: NOW })).toBe(
        "Storage: 1.8 TB (1,234,567 objects), **offsite 3d ago, overdue**"
      );
    });

    it("flags a value that cannot be read", function () {
      expect(storage.line("garbage", { now: NOW })).toBe(
        "Storage: **offsite copy record unreadable**"
      );
    });

    it("is nothing where no copy was ever recorded", function () {
      expect(storage.line(null, { now: NOW })).toBeNull();
      expect(storage.line(undefined, { now: NOW })).toBeNull();
    });
  });

  describe("main", function () {
    it("stores each copy and uses the history the next day", async function () {
      const client = fakeRedis({
        [STORAGE_OFFSITE_KEY]: copyLine({
          age: 9 * HOUR + DAY,
          bytes: 90 * GB,
        }),
      });

      expect((await run({ client, now: NOW - DAY })).storage).toBe(
        "Storage: 90 GB (1,234,567 objects), offsite 9h ago"
      );
      expect(JSON.parse(client.store.get(storage.HISTORY_KEY))).toEqual([
        { time: NOW - 9 * HOUR - DAY, used: 90 * GB },
      ]);

      client.store.set(STORAGE_OFFSITE_KEY, copyLine({ bytes: 93 * GB }));
      expect((await run({ client, now: NOW })).storage).toBe(
        "Storage: 93 GB (+3 GB in 24h, 1,234,567 objects), offsite 9h ago"
      );
      expect(JSON.parse(client.store.get(storage.HISTORY_KEY)).length).toBe(2);

      // A re-run before the next copy changes nothing
      await run({ client, now: NOW + HOUR });
      expect(JSON.parse(client.store.get(storage.HISTORY_KEY)).length).toBe(2);
    });

    it("gives nothing, and stores nothing, where no copy was recorded", async function () {
      const client = fakeRedis();

      expect(await run({ client, now: NOW })).toEqual({});
      expect(client.store.size).toBe(0);
    });

    it("still says so when Redis cannot be read", async function () {
      const client = {
        sendCommand: async () => {
          throw new Error("connection refused");
        },
      };

      expect((await run({ client, now: NOW })).storage).toBe(
        "Storage: unavailable (connection refused)"
      );
    });
  });

  it("renders in the daily email after the server line", function () {
    const fs = require("fs");
    const Mustache = require("mustache");
    const template = fs.readFileSync(
      __dirname + "/../../../helper/email/admin/DAILY_UPDATE.txt",
      "utf8"
    );
    const view = { redis: "Redis: x", server: "Server: y" };

    expect(
      Mustache.render(template, {
        ...view,
        storage: "Storage: 2 TB (5 objects)",
      })
    ).toContain("Server: y\n\nStorage: 2 TB (5 objects)\n\nSync:");
    expect(Mustache.render(template, view)).toContain("Server: y\n\nSync:");
  });
});
