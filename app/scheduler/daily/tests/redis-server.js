const redisServer = require("../redis-server");
const { collect, lines, parseBackup, BACKUP_KEY, SNAPSHOT_KEY, RESIZE_URL } = redisServer;
const { SAMPLE_KEY } = require("../../check-redis-host");

describe("scheduler/daily/redis-server", function () {
  const MINUTE = 60 * 1000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
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

  // INFO as Redis replies
  const info = ({
    used = 3 * GB,
    maxmemory = 11 * GB,
    keys = 1204331,
    saveStatus = "ok",
    saveAge = 3 * MINUTE,
  } = {}) =>
    [
      "# Memory",
      `used_memory:${used}`,
      `maxmemory:${maxmemory}`,
      "mem_not_counted_for_evict:0",
      "# Persistence",
      `rdb_changes_since_last_save:1204`,
      `rdb_last_save_time:${Math.floor((NOW - saveAge) / 1000)}`,
      `rdb_last_bgsave_status:${saveStatus}`,
      "rdb_last_bgsave_time_sec:31",
      "latest_fork_usec:62000",
      "# Keyspace",
      `db0:keys=${keys},expires=10,avg_ttl=0`,
      "",
    ].join("\r\n");

  const snapshotLine = ({ age = DAY, keys = 1200000, memory = 2.9 * GB } = {}) =>
    JSON.stringify({ time: NOW - age, keys, memory });

  // The parts of the Redis client the module uses
  function fakeRedis({
    sample = sampleLine(),
    backup = backupLine(),
    memory = info(),
    snapshot = null,
  } = {}) {
    const store = new Map();
    if (sample !== null) store.set(SAMPLE_KEY, sample);
    if (backup !== null) store.set(BACKUP_KEY, backup);
    if (snapshot !== null) store.set(SNAPSHOT_KEY, snapshot);
    return {
      store,
      sendCommand: async ([command, arg, value]) => {
        if (command === "INFO") {
          expect(arg).toBeUndefined();
          return memory;
        }
        if (command === "GET") return store.has(arg) ? store.get(arg) : null;
        if (command === "SET") return store.set(arg, value) && "OK";
        throw new Error("unexpected command " + command);
      },
    };
  }

  const render = async (options) =>
    lines(await collect({ client: fakeRedis(options), now: NOW }));

  it("reports memory, growth, disk, the last save and the last backup", async function () {
    expect(await render()).toEqual([
      "Memory: 3 GB used of 11 GB maxmemory (27%), 16 GB RAM on the host",
      "Growth: 1,204,331 keys, 3 GB memory; first snapshot, trend from tomorrow",
      "Disk: / 12 GB of 48 GB used (25%), /backups 40 GB of 100 GB used (40%)",
      "Last save: ok, 3 minutes ago, took 31s, fork 62ms, 1,204 changes since",
      "Last backup: 30 minutes ago, hourly/2026-10-08-hour-06.rdb (4 GB)",
    ]);
  });

  it("says so when the Redis host has sent no sample or backup", async function () {
    const result = await render({ sample: null, backup: null });

    expect(result[0]).toBe("Memory: 3 GB used of 11 GB maxmemory (27%), host RAM unknown");
    expect(result[2]).toBe("Disk: no sample from the Redis host");
    expect(result[4]).toBe("Last backup: no backup recorded");
  });

  it("copes with a sample from before the host reported RAM and disk", async function () {
    const result = await render({ sample: sampleLine({ extra: "" }) });

    expect(result[0]).toContain("host RAM unknown");
    expect(result[2]).toBe("Disk: not reported by the Redis host");
  });

  it("says when /backups is not mounted", async function () {
    const extra = ` ram_total=${16 * GB} disk_root=${12 * GB}/${48 * GB}`;
    const result = await render({ sample: sampleLine({ extra }) });

    expect(result[2]).toBe("Disk: / 12 GB of 48 GB used (25%), /backups not mounted");
  });

  it("flags a stale sample and an overdue backup", async function () {
    const result = await render({
      sample: sampleLine({ age: 3 * HOUR }),
      backup: backupLine({ age: 5 * HOUR, kind: "daily", bytes: 0 }),
    });

    expect(result[2]).toContain("(sample from 3 hours ago, the Redis host may have stopped reporting)");
    expect(result[4]).toBe(
      "Last backup: 5 hours ago, daily/2026-10-08-hour-06.rdb, overdue: backups should run every hour"
    );
  });

  describe("last save", function () {
    it("says a failed save stops writes", async function () {
      const result = await render({ memory: info({ saveStatus: "err", saveAge: 2 * HOUR }) });

      expect(result[3]).toBe(
        "Last save: FAILED (err), Redis refuses writes until a save succeeds, 2 hours ago, took 31s, fork 62ms, 1,204 changes since"
      );
    });

    it("copes with Redis not reporting persistence", async function () {
      const result = await render({ memory: "# Memory\r\nused_memory:5\r\nmaxmemory:10\r\n" });
      expect(result[3]).toBe("Last save: not reported by Redis");
    });
  });

  describe("growth", function () {
    it("shows the change over a day and when memory reaches 70% of maxmemory", async function () {
      // +102 MB a day from 3 GB: 70% of 11 GB is 7.7 GB, 47 days away
      const result = await render({ snapshot: snapshotLine({ memory: 2.9 * GB, keys: 1200000 }) });

      expect(result[1]).toBe(
        "Growth: 1,204,331 keys (+4,331 in 24h), 3 GB memory (+102.4 MB in 24h); at this rate 70% of maxmemory in ~47 days"
      );
    });

    it("scales a gap that is not about a day to a day", async function () {
      // +0.2 GB and +9,000 keys in 48h
      const result = await render({
        snapshot: snapshotLine({ age: 2 * DAY, memory: 2.8 * GB, keys: 1195331 }),
      });

      expect(result[1]).toContain("(+4,500 per day, over 48h)");
      expect(result[1]).toContain("(+102.4 MB per day, over 48h)");
      expect(result[1]).toContain("in ~47 days");
    });

    it("leaves the projection out when memory is flat or shrinking", async function () {
      const flat = await render({ snapshot: snapshotLine({ memory: 3 * GB }) });
      expect(flat[1]).toBe("Growth: 1,204,331 keys (+4,331 in 24h), 3 GB memory (+0 Bytes in 24h)");

      const shrinking = await render({ snapshot: snapshotLine({ memory: 3.5 * GB, keys: 1300000 }) });
      expect(shrinking[1]).toBe(
        "Growth: 1,204,331 keys (-95,669 in 24h), 3 GB memory (-512 MB in 24h)"
      );
    });

    it("leaves the projection out once memory is past 70%, where the resize link applies", async function () {
      const result = await render({
        memory: info({ used: 8 * GB }),
        snapshot: snapshotLine({ memory: 7.9 * GB }),
      });

      expect(result[1]).not.toContain("at this rate");
    });

    it("says a very slow growth is more than 2 years away", async function () {
      const result = await render({ snapshot: snapshotLine({ memory: 3 * GB - 1024 * 1024 }) });
      expect(result[1]).toContain("is more than 2 years away");
    });

    it("has no trend from a snapshot that is too recent or unreadable", async function () {
      expect((await render({ snapshot: snapshotLine({ age: 10 * MINUTE }) }))[1]).toContain(
        "too recent for a trend"
      );
      expect((await render({ snapshot: "garbage" }))[1]).toContain("first snapshot, trend from tomorrow");
    });
  });

  it("links to the resize instructions at 70% of maxmemory, not below", async function () {
    const below = await render({ memory: info({ used: 7.69 * GB }) });
    expect(below.join("\n")).not.toContain("close to the limit");

    const at = await render({ memory: info({ used: 7.7 * GB }) });
    expect(at[at.length - 1]).toBe(
      `Memory is getting close to the limit: [increasing the Redis server size](${RESIZE_URL})`
    );
    expect(at[0]).toContain("(70%)");
    expect(RESIZE_URL).toBe(
      "https://github.com/blotcms/blot/blob/master/config/redis/README.md#increasing-the-redis-server-size"
    );

    const over = await render({ memory: info({ used: 10 * GB }) });
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
    expect((await render({ backup: "garbage" }))[4]).toBe("Last backup: no backup recorded");
  });

  describe("main", function () {
    const run = (deps) =>
      new Promise((resolve, reject) =>
        redisServer((err, result) => (err ? reject(err) : resolve(result)), deps)
      );

    it("passes the lines to the email", async function () {
      const result = await run({ client: fakeRedis(), now: NOW });
      expect(Object.keys(result)).toEqual(["redis_server"]);
      expect(result.redis_server.length).toBe(5);
    });

    it("stores today's snapshot for tomorrow's trend", async function () {
      const client = fakeRedis();
      await run({ client, now: NOW });

      expect(JSON.parse(client.store.get(SNAPSHOT_KEY))).toEqual({ time: NOW, keys: 1204331, memory: 3 * GB });

      // A day later it is the trend's baseline
      const tomorrow = await run({ client, now: NOW + DAY });
      expect(tomorrow.redis_server[1]).toContain("(+0 in 24h)");
    });

    it("keeps the previous snapshot when run again within the hour", async function () {
      const snapshot = snapshotLine({ age: 10 * MINUTE });
      const client = fakeRedis({ snapshot });
      await run({ client, now: NOW });

      expect(client.store.get(SNAPSHOT_KEY)).toBe(snapshot);
    });

    it("still sends the lines when the snapshot cannot be stored", async function () {
      const client = fakeRedis();
      const sendCommand = client.sendCommand;
      client.sendCommand = async (args) => {
        if (args[0] === "SET") throw new Error("READONLY");
        return sendCommand(args);
      };

      const result = await run({ client, now: NOW });
      expect(result.redis_server.length).toBe(5);
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
