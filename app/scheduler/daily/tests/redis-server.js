const redisServer = require("../redis-server");
const { collect, lines, parseBackup, BACKUP_KEY, RESIZE_URL } = redisServer;
const { SAMPLE_KEY } = require("../../check-redis-host");

describe("scheduler/daily/redis-server", function () {
  const MINUTE = 60 * 1000;
  const HOUR = 60 * MINUTE;
  const GB = 1024 * 1024 * 1024;
  const NOW = Date.UTC(2026, 9, 8, 7, 0);

  const stamp = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

  // A sample as config/redis/bin/tcpmem-log.sh stores it
  function sampleLine({ age = 2 * MINUTE, extra } = {}) {
    if (extra === undefined) {
      extra =
        ` ram_total=${16 * GB} ram_avail=${12 * GB}` +
        ` disk_root=${12 * GB}/${48 * GB} disk_backups=${40 * GB}/${100 * GB}`;
    }
    return (
      `${stamp(NOW - age)} mem=100 tcp_mem=190000,250000,380000 sockets=25 pressures=0 ` +
      `chrono_ms=0 prune=0 rcvq_drop=0 ofo_drop=0 host=ip-10-0-0-1 active=1${extra}`
    );
  }

  // A value as config/redis/bin/backup.sh stores it
  const backupLine = ({ age = 30 * MINUTE, kind = "hourly", bytes = 4 * GB } = {}) =>
    `${stamp(NOW - age)} ${kind} ${kind}/2026-10-08-hour-06.rdb ${bytes}`;

  const info = ({ used = 3 * GB, maxmemory = 11 * GB } = {}) =>
    `# Memory\r\nused_memory:${used}\r\nmaxmemory:${maxmemory}\r\nmem_not_counted_for_evict:0\r\n`;

  // The parts of the Redis client the module uses
  function fakeRedis({ sample = sampleLine(), backup = backupLine(), memory = info() } = {}) {
    const store = new Map();
    if (sample !== null) store.set(SAMPLE_KEY, sample);
    if (backup !== null) store.set(BACKUP_KEY, backup);
    return {
      sendCommand: async ([command, arg]) => {
        if (command === "INFO") return memory;
        if (command === "GET") return store.has(arg) ? store.get(arg) : null;
        throw new Error("unexpected command " + command);
      },
    };
  }

  const render = async (options) =>
    lines(await collect({ client: fakeRedis(options), now: NOW }));

  it("reports memory, disk and the last backup", async function () {
    expect(await render()).toEqual([
      "Memory: 3 GB used of 11 GB maxmemory (27%), 16 GB RAM on the host",
      "Disk: / 12 GB of 48 GB used (25%), /backups 40 GB of 100 GB used (40%)",
      "Last backup: 30 minutes ago, hourly/2026-10-08-hour-06.rdb (4 GB)",
    ]);
  });

  it("says so when the Redis host has sent no sample or backup", async function () {
    expect(await render({ sample: null, backup: null })).toEqual([
      "Memory: 3 GB used of 11 GB maxmemory (27%), host RAM unknown",
      "Disk: no sample from the Redis host",
      "Last backup: no backup recorded",
    ]);
  });

  it("copes with a sample from before the host reported RAM and disk", async function () {
    const result = await render({ sample: sampleLine({ extra: "" }) });

    expect(result[0]).toContain("host RAM unknown");
    expect(result[1]).toBe("Disk: not reported by the Redis host");
  });

  it("says when /backups is not mounted", async function () {
    const extra = ` ram_total=${16 * GB} disk_root=${12 * GB}/${48 * GB}`;
    const result = await render({ sample: sampleLine({ extra }) });

    expect(result[1]).toBe("Disk: / 12 GB of 48 GB used (25%), /backups not mounted");
  });

  it("flags a stale sample and an overdue backup", async function () {
    const result = await render({
      sample: sampleLine({ age: 3 * HOUR }),
      backup: backupLine({ age: 5 * HOUR, kind: "daily", bytes: 0 }),
    });

    expect(result[1]).toContain("(sample from 3 hours ago, the Redis host may have stopped reporting)");
    expect(result[2]).toBe(
      "Last backup: 5 hours ago, daily/2026-10-08-hour-06.rdb, overdue: backups should run every hour"
    );
  });

  it("links to the resize instructions at 70% of maxmemory, not below", async function () {
    const below = await render({ memory: info({ used: 7.69 * GB, maxmemory: 11 * GB }) });
    expect(below.join("\n")).not.toContain("close to the limit");

    const at = await render({ memory: info({ used: 7.7 * GB, maxmemory: 11 * GB }) });
    expect(at[at.length - 1]).toBe(
      `Memory is getting close to the limit: [increasing the Redis server size](${RESIZE_URL})`
    );
    expect(at[0]).toContain("(70%)");
    expect(RESIZE_URL).toBe(
      "https://github.com/blotcms/blot/blob/master/config/redis/README.md#increasing-the-redis-server-size"
    );

    const over = await render({ memory: info({ used: 10 * GB, maxmemory: 11 * GB }) });
    expect(over.join("\n")).toContain(RESIZE_URL);
  });

  it("copes with no maxmemory", async function () {
    const result = await render({ memory: info({ maxmemory: 0 }) });

    expect(result[0]).toBe("Memory: 3 GB used, no maxmemory set, 16 GB RAM on the host");
    expect(result.join("\n")).not.toContain("close to the limit");
  });

  it("ignores a backup value it cannot read", async function () {
    expect(parseBackup("garbage")).toBe(null);
    expect(parseBackup(null)).toBe(null);
    expect(parseBackup(backupLine({ bytes: 1234 }))).toEqual({
      time: NOW - 30 * MINUTE,
      kind: "hourly",
      key: "hourly/2026-10-08-hour-06.rdb",
      bytes: 1234,
    });
    expect((await render({ backup: "garbage" }))[2]).toBe("Last backup: no backup recorded");
  });

  describe("main", function () {
    const run = (deps) =>
      new Promise((resolve, reject) =>
        redisServer((err, result) => (err ? reject(err) : resolve(result)), deps)
      );

    it("passes the lines to the email", async function () {
      const result = await run({ client: fakeRedis(), now: NOW });
      expect(Object.keys(result)).toEqual(["redis_server"]);
      expect(result.redis_server.length).toBe(3);
    });

    it("never fails the daily email when Redis cannot be read", async function () {
      const client = {
        sendCommand: async () => {
          throw new Error("connection refused");
        },
      };

      expect(await run({ client })).toEqual({ redis_server: ["Unavailable: connection refused"] });
    });

    it("never fails the daily email when INFO is unexpected", async function () {
      const result = await run({ client: fakeRedis({ memory: "# Memory\r\n" }) });
      expect(result.redis_server[0]).toMatch(/^Unavailable: /);
    });
  });
});
