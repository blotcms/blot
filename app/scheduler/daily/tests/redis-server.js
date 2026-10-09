const redisServer = require("../redis-server");
const { collect, line, parseBackup, BACKUP_KEY, SNAPSHOT_KEY, RESIZE_URL } = redisServer;
const { SAMPLE_KEY } = require("../../check-redis-host");

describe("scheduler/daily/redis-server", function () {
  const MINUTE = 60 * 1000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  const GB = 1024 * 1024 * 1024;
  const NOW = Date.UTC(2026, 9, 8, 7, 0);

  beforeEach(function () {
    jasmine.addMatchers({
      toStartWith: () => ({
        compare: (actual, expected) => ({ pass: actual.startsWith(expected) }),
      }),
      toEndWith: () => ({
        compare: (actual, expected) => ({ pass: actual.endsWith(expected) }),
      }),
    });
  });

  const stamp = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

  // A sample as config/redis/bin/tcpmem-log.sh stores it: a 24 GB root disk
  // with 5 GB used (21%), and /backups 40% full unless `extra` says otherwise
  function sampleLine({ age = 2 * MINUTE, extra } = {}) {
    if (extra === undefined) {
      extra =
        ` ram_total=${16 * GB} ram_avail=${12 * GB}` +
        ` disk_root=${5 * GB}/${24 * GB}/${19 * GB} disk_backups=${40 * GB}/${100 * GB}/${60 * GB}`;
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
  const info = ({ used = 3 * GB, maxmemory = 11 * GB, keys = 1204331, saveStatus = "ok", saveAge = 3 * MINUTE } = {}) =>
    [
      "# Memory",
      `used_memory:${used}`,
      `maxmemory:${maxmemory}`,
      "mem_not_counted_for_evict:0",
      "# Persistence",
      "rdb_changes_since_last_save:1204",
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
  function fakeRedis({ sample = sampleLine(), backup = backupLine(), memory = info(), snapshot = null } = {}) {
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

  // A day-old snapshot 0.1 GB lower: 70% of 11 GB is 7.7 GB, ~47 days away
  const withSnapshot = { snapshot: snapshotLine() };

  const render = async (options) => line(await collect({ client: fakeRedis(options), now: NOW }));

  it("is one line: memory with the days to a resize, disk, last save and last backup", async function () {
    expect(await render(withSnapshot)).toBe(
      "Redis server: memory 27% (resize in ~47 days), disk 21% (19 GB free), saved 3m ago, backed up 30m ago"
    );
  });

  describe("memory", function () {
    it("leaves out the projection with no previous snapshot or one that is too recent", async function () {
      const expected = "Redis server: memory 27%, disk 21% (19 GB free), saved 3m ago, backed up 30m ago";

      expect(await render()).toBe(expected);
      expect(await render({ snapshot: snapshotLine({ age: 10 * MINUTE }) })).toBe(expected);
      expect(await render({ snapshot: "garbage" })).toBe(expected);
    });

    it("scales a snapshot that is not a day old to a day", async function () {
      const result = await render({ snapshot: snapshotLine({ age: 2 * DAY, memory: 2.8 * GB }) });
      expect(result).toContain("memory 27% (resize in ~47 days)");
    });

    it("says stable when memory is flat or shrinking", async function () {
      expect(await render({ snapshot: snapshotLine({ memory: 3 * GB }) })).toContain("memory 27% (stable)");
      expect(await render({ snapshot: snapshotLine({ memory: 3.5 * GB }) })).toContain("memory 27% (stable)");
    });

    it("says stable when a resize is more than a year away", async function () {
      // 70% of 11 GB is 7.7 GB: 4.7 GB to go at 12 MB a day is over a year
      const result = await render({ snapshot: snapshotLine({ memory: 3 * GB - 12 * 1024 * 1024 }) });
      expect(result).toContain("memory 27% (stable)");
    });

    it("says to resize now, with the link, from 70% of maxmemory", async function () {
      const below = await render({ memory: info({ used: 7.69 * GB }), ...withSnapshot });
      expect(below).not.toContain("resize now");

      const at = await render({ memory: info({ used: 7.7 * GB }), snapshot: snapshotLine({ memory: 7.6 * GB }) });
      expect(at).toBe(
        `Redis server: memory 70%, **[resize now](${RESIZE_URL})**, disk 21% (19 GB free), saved 3m ago, backed up 30m ago`
      );
      expect(RESIZE_URL).toBe(
        "https://github.com/blotcms/blot/blob/master/config/redis/README.md#increasing-the-redis-server-size"
      );

      expect(await render({ memory: info({ used: 10 * GB }) })).toContain("memory 91%, **[resize now]");
    });

    it("copes with no maxmemory", async function () {
      expect(await render({ memory: info({ maxmemory: 0 }), ...withSnapshot })).toContain(
        "memory 3 GB, no maxmemory set,"
      );
    });
  });

  describe("disk", function () {
    it("shows only the root disk normally", async function () {
      const result = await render();
      expect(result).toContain("disk 21% (19 GB free), saved");
      expect(result).not.toContain("backup disk");
      expect(result).not.toContain("/backups");
    });

    it("says when the backup disk is 80% full or more", async function () {
      const extra = ` disk_root=${5 * GB}/${24 * GB} disk_backups=${79 * GB}/${100 * GB}`;
      expect(await render({ sample: sampleLine({ extra }) })).not.toContain("backup disk");

      const full = ` disk_root=${5 * GB}/${24 * GB} disk_backups=${85 * GB}/${100 * GB}`;
      expect(await render({ sample: sampleLine({ extra: full }) })).toContain(
        "disk 21% (19 GB free), **backup disk 85% full**, saved"
      );
    });

    it("uses df's available figure, which excludes reserved blocks", async function () {
      // 5 GB used of 24 GB, but only 17 GB available: 1 - 17 / (5 + 17) = 23%
      const extra = ` disk_root=${5 * GB}/${24 * GB}/${17 * GB} disk_backups=${78 * GB}/${100 * GB}/${17 * GB}`;
      const result = await render({ sample: sampleLine({ extra }) });

      expect(result).toContain("disk 23% (17 GB free), **backup disk 82% full**, saved");
    });

    it("works out the disk from used and total for a sample without the available figure", async function () {
      const extra = ` disk_root=${5 * GB}/${24 * GB} disk_backups=${85 * GB}/${100 * GB}`;
      expect(await render({ sample: sampleLine({ extra }) })).toContain(
        "disk 21% (19 GB free), **backup disk 85% full**, saved"
      );
    });

    it("says when /backups is not mounted", async function () {
      const extra = ` disk_root=${5 * GB}/${24 * GB}`;
      expect(await render({ sample: sampleLine({ extra }) })).toContain(
        "disk 21% (19 GB free), **/backups not mounted**, saved"
      );
    });

    it("says so when the host has sent no sample", async function () {
      expect(await render({ sample: null })).toBe(
        "Redis server: memory 27%, no sample from the Redis host, saved 3m ago, backed up 30m ago"
      );
    });

    it("says how old a stale sample is instead of using it", async function () {
      expect(await render({ sample: sampleLine({ age: 45 * MINUTE }) })).toContain("memory 27%, sample 45m old, saved");
      expect(await render({ sample: sampleLine({ age: 3 * HOUR }) })).toContain("sample 3h old");
    });

    it("copes with a sample from before the host reported disk", async function () {
      expect(await render({ sample: sampleLine({ extra: "" }) })).toContain("disk not reported by the Redis host");
    });
  });

  describe("last save", function () {
    it("says how long ago, in compact units", async function () {
      expect(await render({ memory: info({ saveAge: 2 * HOUR }) })).toContain("saved 2h ago");
      expect(await render({ memory: info({ saveAge: 3 * DAY }) })).toContain("saved 3d ago");
    });

    it("says a failed save, instead of when", async function () {
      const result = await render({ memory: info({ saveStatus: "err" }) });
      expect(result).toContain("**last save failed**, backed up");
      expect(result).not.toContain("saved");
    });

    it("copes with Redis not reporting persistence", async function () {
      const result = await render({ memory: "# Memory\r\nused_memory:5\r\nmaxmemory:10\r\n" });
      expect(result).toContain("save not reported");
    });
  });

  describe("last backup", function () {
    it("says how long ago", async function () {
      expect(await render({ backup: backupLine({ age: 2 * HOUR }) })).toEndWith("backed up 2h ago");
    });

    it("says overdue after two hours", async function () {
      expect(await render({ backup: backupLine({ age: 3 * HOUR, kind: "daily" }) })).toEndWith(
        "**last backup 3h ago, overdue**"
      );
      expect(await render({ backup: backupLine({ age: 3 * DAY }) })).toEndWith(
        "**last backup 3d ago, overdue**"
      );
    });

    it("says when none is recorded or it cannot be read", async function () {
      expect(await render({ backup: null })).toEndWith("**no backup recorded**");
      expect(await render({ backup: "garbage" })).toEndWith("**no backup recorded**");
      expect(parseBackup(null)).toBe(null);
      expect(parseBackup(backupLine({ bytes: 1234 }))).toEqual({
        time: NOW - 30 * MINUTE,
        kind: "hourly",
        key: "hourly/2026-10-08-hour-06.rdb",
        bytes: 1234,
      });
    });
  });

  describe("main", function () {
    const run = (deps) =>
      new Promise((resolve, reject) =>
        redisServer((err, result) => (err ? reject(err) : resolve(result)), deps)
      );

    it("passes the line to the email", async function () {
      const result = await run({ client: fakeRedis(withSnapshot), now: NOW });
      expect(Object.keys(result)).toEqual(["redis_server"]);
      expect(result.redis_server).toStartWith("Redis server: memory 27% (resize in ~47 days)");
      expect(result.redis_server).not.toContain("\n");
    });

    it("stores today's snapshot for tomorrow's projection", async function () {
      const client = fakeRedis();
      await run({ client, now: NOW });

      expect(JSON.parse(client.store.get(SNAPSHOT_KEY))).toEqual({ time: NOW, keys: 1204331, memory: 3 * GB });

      // A day later it is the baseline: no growth
      const tomorrow = await run({ client, now: NOW + DAY });
      expect(tomorrow.redis_server).toContain("memory 27% (stable)");
    });

    it("keeps the previous snapshot when run again within the hour", async function () {
      const snapshot = snapshotLine({ age: 10 * MINUTE });
      const client = fakeRedis({ snapshot });
      await run({ client, now: NOW });

      expect(client.store.get(SNAPSHOT_KEY)).toBe(snapshot);
    });

    it("still sends the line when the snapshot cannot be stored", async function () {
      const client = fakeRedis();
      const sendCommand = client.sendCommand;
      client.sendCommand = async (args) => {
        if (args[0] === "SET") throw new Error("READONLY");
        return sendCommand(args);
      };

      const result = await run({ client, now: NOW });
      expect(result.redis_server).toStartWith("Redis server: memory 27%");
    });

    it("never fails the daily email when Redis cannot be read", async function () {
      const client = {
        sendCommand: async () => {
          throw new Error("connection refused");
        },
      };

      expect(await run({ client })).toEqual({ redis_server: "Redis server: unavailable (connection refused)" });
    });

    it("never fails the daily email when INFO is unexpected", async function () {
      const result = await run({ client: fakeRedis({ memory: "# Memory\r\n" }) });
      expect(result.redis_server).toMatch(/^Redis server: unavailable \(INFO memory has no used_memory/);
    });
  });

  it("renders as one paragraph in the daily email", function () {
    const fs = require("fs");
    const Mustache = require("mustache");
    const { marked } = require("marked");
    const template = fs.readFileSync(__dirname + "/../../../helper/email/admin/DAILY_UPDATE.txt", "utf8");

    const html = marked.parse(
      Mustache.render(template, {
        render_time: "p50 10ms",
        redis_server: `Redis server: memory 72%, **[resize now](${RESIZE_URL})**, disk 21% (19 GB free), saved 3m ago`,
      })
    );

    expect(html).toContain(
      `<p>Redis server: memory 72%, <strong><a href="${RESIZE_URL}">resize now</a></strong>, disk 21% (19 GB free), saved 3m ago</p>`
    );
  });
});
