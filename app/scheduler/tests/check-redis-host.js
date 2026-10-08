describe("scheduler check-redis-host", function () {
  const run = require("../check-redis-host");
  const {
    check,
    view,
    parseSample,
    parseMemory,
    SAMPLE_KEY,
    STATE_KEY,
    CONDITION_MIN_INTERVAL,
    EVENT_COOLDOWN,
  } = run;

  const MINUTE = 60 * 1000;
  const GB = 1024 * 1024 * 1024;
  const NOW = Date.UTC(2026, 9, 7, 12, 2);

  const stamp = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

  // A line as config/redis/bin/tcpmem-log.sh stores it
  function sampleLine({
    time = NOW - 2 * MINUTE,
    mem = 100,
    tcpMem = "190000,250000,380000",
    pressures = 0,
    host = "ip-10-0-0-1",
    active = 1,
  } = {}) {
    return (
      `${stamp(time)} mem=${mem} tcp_mem=${tcpMem} sockets=25 ` +
      `pressures=${pressures} chrono_ms=0 prune=0 rcvq_drop=0 ofo_drop=0 ` +
      `host=${host} active=${active}`
    );
  }

  // INFO as Redis replies: the sections the check reads. `extra` adds or
  // overrides fields, e.g. { rdb_last_bgsave_status: "err" }.
  function info({ used = 1 * GB, maxmemory = 10 * GB, notCounted = 0, extra = {}, errors = {} } = {}) {
    const fields = {
      run_id: "a".repeat(40),
      redis_version: "6.2.12",
      uptime_in_seconds: 100000,
      rdb_last_bgsave_status: "ok",
      rdb_last_save_time: Math.floor((NOW - 3 * MINUTE) / 1000),
      rejected_connections: 0,
      ...extra,
    };
    return [
      "# Server",
      `run_id:${fields.run_id}`,
      `redis_version:${fields.redis_version}`,
      `uptime_in_seconds:${fields.uptime_in_seconds}`,
      "# Memory",
      `used_memory:${used}`,
      "used_memory_human:1.00G",
      `maxmemory:${maxmemory}`,
      "maxmemory_policy:noeviction",
      `mem_not_counted_for_evict:${notCounted}`,
      "# Persistence",
      `rdb_last_bgsave_status:${fields.rdb_last_bgsave_status}`,
      `rdb_last_save_time:${fields.rdb_last_save_time}`,
      "# Stats",
      `rejected_connections:${fields.rejected_connections}`,
      "# Errorstats",
      ...Object.keys(errors).map((type) => `errorstat_${type}:count=${errors[type]}`),
      "",
    ].join("\r\n");
  }

  // The parts of the Redis client the check uses. `memory` holds the INFO
  // values (see info()), `slowlog` the SLOWLOG GET reply.
  function fakeRedis({ sample = sampleLine(), memory = {}, slowlog = [] } = {}) {
    const store = new Map();
    if (sample !== null) store.set(SAMPLE_KEY, sample);
    const redis = {
      store,
      memory,
      slowlog,
      commands: [],
      sendCommand: async ([command, ...args]) => {
        redis.commands.push(command);
        if (command === "GET") return store.has(args[0]) ? store.get(args[0]) : null;
        if (command === "SET") return store.set(args[0], args[1]) && "OK";
        if (command === "INFO") {
          expect(args).toEqual([]);
          return info(redis.memory);
        }
        if (command === "SLOWLOG") {
          expect(args).toEqual(["GET", "128"]);
          return redis.slowlog;
        }
        throw new Error("unexpected command " + command);
      },
    };
    return redis;
  }

  // Runs the check like the scheduler: continuously, 5 minutes apart
  function harness(options) {
    const client = fakeRedis(options);
    const sent = [];
    let now = NOW;
    let lastCheckAt = NOW - 5 * MINUTE;

    return {
      client,
      sent,
      set sample(value) {
        client.store.set(SAMPLE_KEY, value);
      },
      get state() {
        return JSON.parse(client.store.get(STATE_KEY) || "null");
      },
      tick: async (deps = {}) => {
        const result = await run({
          now,
          lastCheckAt,
          client,
          sendEmail: async (v) => sent.push(v),
          ...deps,
        });
        lastCheckAt = now;
        now += 5 * MINUTE;
        return result;
      },
      get now() {
        return now;
      },
      // Time passing between checks (which carry on meanwhile)
      advance: (ms) => {
        now += ms;
        lastCheckAt = now - 5 * MINUTE;
      },
    };
  }

  const titles = (v) => v.alerts.map((a) => a.title);

  describe("parsing", function () {
    it("reads the sample tcpmem-log.sh stores", function () {
      expect(parseSample(sampleLine({ mem: 1234, pressures: 2 }))).toEqual({
        time: NOW - 2 * MINUTE,
        mem: 1234,
        tcpMem: [190000, 250000, 380000],
        sockets: 25,
        pressures: 2,
        host: "ip-10-0-0-1",
        active: true,
        ramTotal: null,
        ramAvailable: null,
        diskRoot: null,
        diskBackups: null,
      });
    });

    it("reads the RAM and disk fields a newer tcpmem-log.sh adds", function () {
      const sample = parseSample(
        sampleLine() +
          " ram_total=16384000000 ram_avail=12288000000" +
          " disk_root=256000000/1024000000/716800000 disk_backups=512000000/2048000000"
      );

      expect(sample.mem).toBe(100);
      expect(sample.active).toBe(true);
      expect(sample.ramTotal).toBe(16384000000);
      expect(sample.ramAvailable).toBe(12288000000);
      expect(sample.diskRoot).toEqual({ used: 256000000, total: 1024000000, available: 716800000 });
      // The older form has no available figure
      expect(sample.diskBackups).toEqual({ used: 512000000, total: 2048000000, available: null });
    });

    it("leaves out RAM and disk fields that are missing or malformed", function () {
      const sample = parseSample(
        sampleLine() + " ram_total=lots ram_avail= disk_root=5 disk_backups=1/0"
      );

      expect(sample.mem).toBe(100);
      expect(sample.ramTotal).toBe(null);
      expect(sample.ramAvailable).toBe(null);
      expect(sample.diskRoot).toBe(null);
      expect(sample.diskBackups).toBe(null);
    });

    it("rejects a malformed sample", function () {
      expect(parseSample(null)).toBe(null);
      expect(parseSample("garbage")).toBe(null);
      expect(parseSample(sampleLine({ tcpMem: "1,2" }))).toBe(null);
      expect(parseSample(sampleLine().replace(/mem=\d+/, "mem="))).toBe(null);
    });

    it("keeps the host name to safe characters", function () {
      expect(parseSample(sampleLine({ host: "a<b>.c" })).host).toBe("ab.c");
    });

    it("leaves what Redis does not count against maxmemory out of used", function () {
      expect(parseMemory(info({ used: 5 * GB, notCounted: 1 * GB, maxmemory: 0 }))).toEqual({
        used: 4 * GB,
        maxmemory: 0,
      });
    });
  });

  describe("TCP memory", function () {
    it("is quiet for a healthy host", async function () {
      const h = harness();
      const { sent } = await h.tick();
      expect(sent).toBe(false);
      expect(h.sent).toEqual([]);
    });

    it("alerts once at half of tcp_mem[1], then once when it clears", async function () {
      const h = harness({ sample: sampleLine({ mem: 125000 }) });

      await h.tick();
      expect(h.sent.length).toBe(1);
      expect(titles(h.sent[0])).toEqual(["TCP memory nearing tcp_mem[1]"]);
      expect(h.sent[0].alerts[0].message).toContain("50% of tcp_mem[1] (250000)");

      await h.tick();
      expect(h.sent.length).toBe(1);

      // Between the clear and alert thresholds it stays on
      h.sample = sampleLine({ time: h.now, mem: 115000 });
      await h.tick();
      expect(h.sent.length).toBe(1);

      // The clear waits for the hour since the start email to pass
      h.sample = sampleLine({ time: h.now, mem: 100000 });
      await h.tick();
      expect(h.sent.length).toBe(1);

      h.advance(CONDITION_MIN_INTERVAL);
      h.sample = sampleLine({ time: h.now, mem: 100000 });
      await h.tick();
      expect(h.sent.length).toBe(2);
      expect(h.sent[1].hasAlerts).toBe(false);
      expect(h.sent[1].summary).toBe("recovered: TCP memory nearing tcp_mem[1]");
    });

    it("alerts on each rise in the pressure counter", async function () {
      const h = harness({ sample: sampleLine({ pressures: 1 }) });

      // The first sample only sets the baseline
      await h.tick();
      expect(h.sent).toEqual([]);
      expect(h.state.pressures).toEqual({ host: "ip-10-0-0-1", count: 1 });

      h.sample = sampleLine({ time: h.now, pressures: 2 });
      await h.tick();
      expect(h.sent.length).toBe(1);
      expect(titles(h.sent[0])).toEqual(["TCP memory pressure"]);
      expect(h.sent[0].alerts[0].message).toContain("from 1 to 2");

      await h.tick();
      expect(h.sent.length).toBe(1);
    });

    it("starts a new baseline on a new host or after a reboot", async function () {
      const h = harness({ sample: sampleLine({ pressures: 5 }) });
      await h.tick();

      h.sample = sampleLine({ time: h.now, pressures: 0 });
      await h.tick();
      h.sample = sampleLine({ time: h.now, pressures: 6, host: "ip-10-0-0-2" });
      await h.tick();

      expect(h.sent).toEqual([]);
      expect(h.state.pressures).toEqual({ host: "ip-10-0-0-2", count: 6 });
    });

    it("says nothing before the host stores samples", async function () {
      const h = harness({ sample: null, memory: { maxmemory: 0 } });
      await h.tick();
      expect(h.sent).toEqual([]);
    });
  });

  describe("stale sample", function () {
    it("alerts once when samples stop, and when they resume", async function () {
      const h = harness({ sample: sampleLine({ time: NOW - 21 * MINUTE }) });

      await h.tick();
      expect(titles(h.sent[0])).toEqual(["TCP memory sample stale"]);
      expect(h.sent[0].alerts[0].message).toContain("21 minutes old");

      await h.tick();
      expect(h.sent.length).toBe(1);

      h.advance(CONDITION_MIN_INTERVAL);
      h.sample = sampleLine({ time: h.now });
      await h.tick();
      expect(h.sent[1].summary).toBe("recovered: TCP memory sample stale");
    });

    it("does not judge staleness right after an outage or a restart", async function () {
      const h = harness({ sample: sampleLine({ time: NOW - 40 * MINUTE }) });

      await h.tick({ lastCheckAt: NOW - 30 * MINUTE });
      await h.tick({ lastCheckAt: null });
      expect(h.sent).toEqual([]);
    });

    it("keeps a TCP memory alert while the sample is stale", async function () {
      const h = harness({ sample: sampleLine({ mem: 200000 }) });
      await h.tick();

      h.sample = sampleLine({ time: h.now - 30 * MINUTE, mem: 10 });
      await h.tick();

      expect(h.sent.map(titles)).toEqual([
        ["TCP memory nearing tcp_mem[1]"],
        ["TCP memory sample stale"],
      ]);
      expect(Object.keys(h.state.alerts).sort()).toEqual(["sample-stale", "tcp-mem"]);
    });
  });

  describe("maxmemory", function () {
    it("alerts once at 80%, then once below 75%", async function () {
      const h = harness({ memory: { used: 8 * GB, maxmemory: 10 * GB } });

      await h.tick();
      expect(titles(h.sent[0])).toEqual(["Redis memory nearing maxmemory"]);
      expect(h.sent[0].alerts[0].message).toBe("8.00GB of 10.00GB (80%)");

      h.client.memory.used = 7.6 * GB;
      await h.tick();
      expect(h.sent.length).toBe(1);

      h.advance(CONDITION_MIN_INTERVAL);
      h.sample = sampleLine({ time: h.now });
      h.client.memory.used = 7.4 * GB;
      await h.tick();
      expect(h.sent[1].summary).toBe("recovered: Redis memory nearing maxmemory");
    });

    it("ignores replica output buffers, as Redis does", async function () {
      const h = harness({ memory: { used: 9 * GB, notCounted: 2 * GB, maxmemory: 10 * GB } });
      await h.tick();
      expect(h.sent).toEqual([]);
    });

    it("alerts on an unset maxmemory only on a host marked active", async function () {
      const before = harness({ sample: sampleLine({ active: 0 }), memory: { maxmemory: 0 } });
      await before.tick();
      expect(before.sent).toEqual([]);

      const after = harness({ sample: sampleLine({ active: 1 }), memory: { maxmemory: 0 } });
      await after.tick();
      await after.tick();
      expect(after.sent.length).toBe(1);
      expect(titles(after.sent[0])).toEqual(["maxmemory not set"]);
    });
  });

  describe("sending", function () {
    it("saves nothing when the email fails, so the next run retries", async function () {
      const h = harness({ memory: { used: 9 * GB, maxmemory: 10 * GB } });

      await expectAsync(
        h.tick({ sendEmail: async () => Promise.reject(new Error("mailgun")) })
      ).toBeRejected();
      expect(h.state).toBe(null);

      await h.tick();
      expect(h.sent.length).toBe(1);
    });

    it("propagates a Redis error for the scheduler to log", async function () {
      const client = fakeRedis();
      const err = new Error("offline");
      client.sendCommand = async () => Promise.reject(err);
      await expectAsync(run({ client, now: NOW })).toBeRejectedWith(err);
    });

    it("renders the readings and thresholds", async function () {
      const report = await check({
        now: NOW,
        lastCheckAt: NOW - 5 * MINUTE,
        client: fakeRedis({ memory: { used: 2 * GB, maxmemory: 0 } }),
      });
      const v = view(report);

      expect(v.readings).toEqual([
        "TCP memory on ip-10-0-0-1: 100 pages, 0% of tcp_mem[1] (tcp_mem 190000 250000 380000), 25 sockets, pressures=0, sampled 2 minutes ago",
        "Redis memory: 2.00GB, no maxmemory",
        "Last background save: ok, 3 minutes ago; Redis 6.2.12, up 28 hours",
      ]);
      expect(v.thresholds).toEqual({
        tcpMem: "50%",
        maxmemory: "80%",
        stale: "20 minutes",
        errors: 100,
        slowlog: "50ms",
        conditionInterval: "1 hour",
        eventCooldown: "6 hours",
      });
    });

    it("renders the email template", function (done) {
      const fs = require("fs");
      const Mustache = require("mustache");
      const template = fs.readFileSync(
        __dirname + "/../../helper/email/admin/REDIS_HOST_ALERT.txt",
        "utf8"
      );

      check({
        now: NOW,
        lastCheckAt: NOW - 5 * MINUTE,
        client: fakeRedis({
          sample: sampleLine({ mem: 200000 }),
          memory: { used: 9 * GB, maxmemory: 10 * GB },
        }),
      })
        .then((report) => {
          const text = Mustache.render(template, view(report));
          expect(text.split("\n")[0]).toBe(
            "Redis host: TCP memory nearing tcp_mem[1], Redis memory nearing maxmemory"
          );
          expect(text).toContain("- **Redis memory nearing maxmemory**: 9.00GB of 10.00GB (90%)");
          expect(text).toContain("alert at 50% of `tcp_mem[1]`");
          expect(text).not.toContain("Recovered");
          done();
        })
        .catch(done.fail);
    });
  });

  // Events, background saves and rate limits. Each check also refreshes the
  // host's sample, so the clock can move without it going stale.
  const set = (h, extra, errors) => {
    h.client.memory.extra = extra;
    if (errors) h.client.memory.errors = errors;
    h.sample = sampleLine({ time: h.now });
  };

  describe("background save", function () {
    it("alerts at once, explaining why it is urgent, and clears when a save succeeds", async function () {
      const h = harness({ memory: { extra: { rdb_last_bgsave_status: "err" } } });

      await h.tick();
      expect(h.sent.length).toBe(1);
      expect(h.sent[0].summary).toBe("Redis background save failing, writes will be refused");

      const { message } = h.sent[0].alerts[0];
      expect(message).toContain("rdb_last_bgsave_status:err");
      expect(message).toContain("stop-writes-on-bgsave-error yes");
      expect(message).toContain("refuses every write");
      expect(message).toContain("/var/lib/redis6");
      expect(message).toContain("/var/log/redis6/redis6.log");
      expect(message).toContain("vm.overcommit_memory");
      expect(message).toContain("(https://github.com/blotcms/blot/blob/master/config/redis/README.md)");

      set(h, { rdb_last_bgsave_status: "err" });
      await h.tick();
      expect(h.sent.length).toBe(1);

      h.advance(CONDITION_MIN_INTERVAL);
      set(h, { rdb_last_bgsave_status: "ok" });
      await h.tick();
      expect(h.sent[1].summary).toBe("recovered: Redis background save failing, writes will be refused");
    });
  });

  describe("rate limits", function () {
    const status = (h, value) => set(h, { rdb_last_bgsave_status: value });

    it("holds a clear back until an hour after the last email, then says it was flapping", async function () {
      const h = harness({ memory: { extra: { rdb_last_bgsave_status: "err" } } });
      await h.tick(); // emailed: failing

      status(h, "ok");
      await h.tick(); // would clear, too soon
      status(h, "err");
      await h.tick(); // failing again
      status(h, "ok");
      await h.tick();
      expect(h.sent.length).toBe(1);
      expect(h.state.alerts["bgsave-failed"]).toBeDefined();

      h.advance(CONDITION_MIN_INTERVAL);
      status(h, "ok");
      await h.tick();
      expect(h.sent.length).toBe(2);
      expect(h.sent[1].recovered[0].note).toBe(
        "flapping: it changed state 3 times since the last email about it"
      );
    });

    it("sends nothing for a blip that is over before the hour is", async function () {
      const h = harness({ memory: { extra: { rdb_last_bgsave_status: "err" } } });
      await h.tick();
      status(h, "ok");
      await h.tick();
      status(h, "err");
      await h.tick();

      h.advance(CONDITION_MIN_INTERVAL);
      status(h, "err");
      await h.tick();
      expect(h.sent.length).toBe(1);
      // Settled: the flapping is forgotten
      expect(h.state.mail["bgsave-failed"].flaps).toBe(0);
    });

    it("says a start is flapping when it comes back after a clear", async function () {
      const h = harness();
      await h.tick();
      status(h, "err");
      await h.tick(); // start email
      h.advance(CONDITION_MIN_INTERVAL);
      status(h, "ok");
      await h.tick(); // clear email
      status(h, "err");
      await h.tick(); // start, too soon
      status(h, "ok");
      await h.tick();
      status(h, "err");
      await h.tick();
      expect(h.sent.length).toBe(2);

      h.advance(CONDITION_MIN_INTERVAL);
      status(h, "err");
      await h.tick();
      expect(h.sent.length).toBe(3);
      expect(h.sent[2].alerts[0].message).toContain("flapping: it changed state 3 times");
    });

    it("sends an event type at most once per cooldown and batches the rest", async function () {
      const h = harness();
      await h.tick(); // baseline

      set(h, { rejected_connections: 5 });
      await h.tick();
      expect(h.sent.length).toBe(1);
      expect(h.sent[0].alerts[0].message).toContain("rejected 5 connections");

      set(h, { rejected_connections: 8 });
      await h.tick();
      set(h, { rejected_connections: 13 });
      await h.tick();
      expect(h.sent.length).toBe(1);
      expect(h.state.pending.rejected).toEqual({ count: 8 });

      h.advance(EVENT_COOLDOWN.default);
      set(h, { rejected_connections: 13 });
      await h.tick();
      expect(h.sent.length).toBe(2);
      expect(h.sent[1].alerts[0].message).toContain("rejected 8 connections");
      expect(h.sent[1].alerts[0].message).toContain("held back by the limit of one email per 6 hours");
      expect(h.state.pending).toEqual({});
    });

    it("does not let one event type's email delay another's", async function () {
      const h = harness();
      await h.tick();
      set(h, { rejected_connections: 1 });
      await h.tick();
      set(h, { rejected_connections: 1, uptime_in_seconds: 5 });
      await h.tick();
      expect(h.sent.map((v) => v.summary)).toEqual([
        "Redis rejected connections",
        "Redis restarted or switched host",
      ]);
    });

    it("keeps the TCP pressure alert to one email per cooldown too", async function () {
      const h = harness({ sample: sampleLine({ pressures: 1 }) });
      await h.tick();
      h.sample = sampleLine({ time: h.now, pressures: 2 });
      await h.tick();
      h.sample = sampleLine({ time: h.now, pressures: 5 });
      await h.tick();
      expect(h.sent.length).toBe(1);

      h.advance(EVENT_COOLDOWN.default);
      h.sample = sampleLine({ time: h.now, pressures: 5 });
      await h.tick();
      expect(h.sent.length).toBe(2);
      expect(h.sent[1].alerts[0].message).toContain("from 2 to 5");
    });

    it("keeps pending events and the counters if the email fails", async function () {
      const h = harness();
      await h.tick();
      set(h, { rejected_connections: 4 });
      await expectAsync(
        h.tick({ sendEmail: async () => Promise.reject(new Error("mailgun")) })
      ).toBeRejected();

      set(h, { rejected_connections: 4 });
      await h.tick();
      expect(h.sent.length).toBe(1);
      expect(h.sent[0].alerts[0].message).toContain("rejected 4 connections");
    });
  });

  describe("errors", function () {
    it("alerts at once on any error that means Redis refused writes", async function () {
      const h = harness({ memory: { errors: { OOM: 10, ERR: 5 } } });
      await h.tick(); // baseline

      set(h, {}, { OOM: 12, MISCONF: 3, ERR: 5 });
      await h.tick();
      expect(h.sent.length).toBe(1);
      expect(h.sent[0].summary).toBe("Redis refused writes (OOM, MISCONF)");
      expect(h.sent[0].alerts[0].message).toContain("MISCONF 3, OOM 2");
    });

    it("alerts on other errors only at 100 or more in a window, with counts per type", async function () {
      const h = harness({ memory: { errors: { READONLY: 0, WRONGTYPE: 0 } } });
      await h.tick();

      set(h, {}, { READONLY: 99, WRONGTYPE: 40 });
      await h.tick();
      expect(h.sent).toEqual([]);

      set(h, {}, { READONLY: 99 + 340, WRONGTYPE: 80, ERR: 120 });
      await h.tick();
      expect(h.sent.length).toBe(1);
      expect(h.sent[0].summary).toBe("Redis errors");
      expect(h.sent[0].alerts[0].message).toContain("READONLY 340, ERR 120");
      expect(h.sent[0].alerts[0].message).not.toContain("WRONGTYPE");
    });

    it("does not alert on counters that went down after a restart", async function () {
      const h = harness({ memory: { errors: { OOM: 50, READONLY: 900 } } });
      await h.tick();

      // Restarted: the counters start again, and only the restart is reported
      set(h, { uptime_in_seconds: 30 }, { OOM: 2, READONLY: 300 });
      await h.tick();
      expect(h.sent.map((v) => v.summary)).toEqual(["Redis restarted or switched host"]);

      // Counters reset without a restart (CONFIG RESETSTAT): no negative delta
      set(h, { uptime_in_seconds: 330 }, { OOM: 0 });
      await h.tick();
      expect(h.sent.length).toBe(1);

      // Counting carries on from the new baseline
      set(h, { uptime_in_seconds: 630 }, { OOM: 1 });
      await h.tick();
      expect(h.sent.map((v) => v.summary)).toEqual([
        "Redis restarted or switched host",
        "Redis refused writes (OOM, MISCONF)",
      ]);
      expect(h.sent[1].alerts[0].message).toContain("OOM 1");
    });
  });

  describe("restarts", function () {
    it("alerts when uptime goes backwards, naming the host from the sample", async function () {
      const h = harness({ memory: { extra: { uptime_in_seconds: 50000 } } });
      await h.tick();
      set(h, { uptime_in_seconds: 400 });
      await h.tick();

      expect(h.sent.length).toBe(1);
      const { message } = h.sent[0].alerts[0];
      expect(message).toContain("Redis restarted or a different host/process is now serving (e.g. after a cutover)");
      expect(message).toContain("uptime went backwards");
      expect(message).toContain("the last tcpmem sample was from ip-10-0-0-1");
    });

    it("alerts when run_id or version changes, and not when uptime just grows", async function () {
      const h = harness();
      await h.tick();
      set(h, { uptime_in_seconds: 100300 });
      await h.tick();
      expect(h.sent).toEqual([]);

      set(h, { uptime_in_seconds: 100600, run_id: "b".repeat(40) });
      await h.tick();
      expect(h.sent[0].alerts[0].message).toContain("run_id changed");

      h.advance(EVENT_COOLDOWN.default);
      set(h, { uptime_in_seconds: 100900, run_id: "b".repeat(40), redis_version: "6.2.14" });
      await h.tick();
      expect(h.sent[1].alerts[0].message).toContain("version changed from 6.2.12 to 6.2.14");
    });
  });

  describe("slow commands", function () {
    const entry = (id, ms, ...args) => [id, Math.floor(NOW / 1000), ms * 1000, args, "127.0.0.1:5000", ""];

    it("starts from what is already in the slowlog without reporting it", async function () {
      const h = harness({ slowlog: [entry(7, 900, "KEYS", "*")] });
      await h.tick();
      set(h, {});
      await h.tick();
      expect(h.sent).toEqual([]);
      expect(h.state.observed.slowlogId).toBe(7);
    });

    it("ignores entries under the threshold", async function () {
      const h = harness();
      await h.tick();
      h.client.slowlog = [entry(1, 49, "SMEMBERS", "big"), entry(0, 12, "GET", "x")];
      await h.tick();
      expect(h.sent).toEqual([]);
    });

    it("batches the worst ten with a count of the rest, once per id", async function () {
      const h = harness();
      await h.tick();

      const entries = [];
      for (let i = 0; i < 13; i++) entries.push(entry(i, 60 + i * 10, "SMEMBERS", "set:" + i, "x".repeat(200)));
      h.client.slowlog = entries.reverse(); // newest first, as Redis replies
      set(h, {});
      await h.tick();

      expect(h.sent.length).toBe(1);
      expect(h.sent[0].summary).toBe("Slow Redis commands");
      const { message } = h.sent[0].alerts[0];
      expect(message).toContain("13 commands took at least 50ms");
      expect(message).toContain("180ms at 12:02Z: `SMEMBERS set:12 xxxx");
      expect(message).toContain("…`");
      expect(message).toContain("and 3 more");
      expect(message).not.toContain("set:0 ");
      // The command, a key and an argument, cut at 100 characters
      expect(message.split("\n")[1].length).toBeLessThan(160);

      // The same entries are not new next time
      h.advance(EVENT_COOLDOWN.default);
      set(h, {});
      await h.tick();
      expect(h.sent.length).toBe(1);
    });

    it("reads new ids again after a restart resets them", async function () {
      const h = harness({ slowlog: [entry(40, 300, "KEYS", "*")] });
      await h.tick();

      set(h, { uptime_in_seconds: 20 });
      h.client.slowlog = [entry(1, 120, "ZRANGE", "k", "0", "-1")];
      await h.tick();
      expect(h.sent[0].alerts.map((a) => a.title)).toEqual([
        "Redis restarted or switched host",
        "Slow Redis commands",
      ]);
      expect(h.state.observed.slowlogId).toBe(1);
    });

    it("reads new ids again after SLOWLOG RESET", async function () {
      const h = harness({ slowlog: [entry(40, 300, "KEYS", "*")] });
      await h.tick();

      h.client.slowlog = [entry(0, 90, "SORT", "k")];
      await h.tick();
      expect(h.sent.length).toBe(1);
      expect(h.sent[0].alerts[0].message).toContain("`SORT k`");
    });
  });

  describe("cost", function () {
    it("reads Redis with one INFO and one SLOWLOG GET per check", async function () {
      const client = fakeRedis();
      await check({ now: NOW, client });
      expect(client.commands.filter((c) => c === "INFO").length).toBe(1);
      expect(client.commands.filter((c) => c === "SLOWLOG").length).toBe(1);
    });
  });

  describe("review fixes", function () {
    it("keeps the state in memory when Redis refuses the write, so the alert is not repeated", async function () {
      const h = harness({ memory: { extra: { rdb_last_bgsave_status: "err" } } });
      const keep = { state: null };
      const write = h.client.sendCommand;
      h.client.sendCommand = async (args) => {
        if (args[0] === "SET") throw new Error("MISCONF Errors writing to the AOF file");
        return write(args);
      };

      await h.tick({ keep });
      expect(h.sent.length).toBe(1);
      expect(h.state).toBe(null);
      expect(keep.state.alerts["bgsave-failed"]).toBeDefined();

      // Redis still has no state, but the next runs know the email went out
      await h.tick({ keep });
      await h.tick({ keep });
      expect(h.sent.length).toBe(1);

      // Once a write gets through, Redis has it and the copy is dropped
      h.client.sendCommand = write;
      await h.tick({ keep });
      expect(h.sent.length).toBe(1);
      expect(keep.state).toBe(null);
      expect(h.state.alerts["bgsave-failed"]).toBeDefined();
    });

    it("prefers what Redis holds when that is newer than the copy kept in memory", async function () {
      const h = harness({ memory: { extra: { rdb_last_bgsave_status: "err" } } });
      const keep = {
        state: { updatedAt: 1, alerts: { "bgsave-failed": 1 }, mail: { "bgsave-failed": { at: 1, flaps: 0 } } },
      };
      h.client.store.set(STATE_KEY, JSON.stringify({ updatedAt: 2, alerts: {} }));

      await h.tick({ keep });
      expect(h.sent.length).toBe(1);
    });

    it("sends the originating host with a pressure event held by the cooldown", async function () {
      const h = harness({ sample: sampleLine({ pressures: 1 }) });
      await h.tick();
      h.sample = sampleLine({ time: h.now, pressures: 2 });
      await h.tick(); // emailed
      h.sample = sampleLine({ time: h.now, pressures: 4 });
      await h.tick(); // held
      expect(h.state.pending["tcp-pressure"]).toEqual({ from: 2, to: 4, host: "ip-10-0-0-1" });

      // By the time it is sent the sample is missing
      h.advance(EVENT_COOLDOWN.default);
      h.sample = null;
      await h.tick();
      expect(h.sent.length).toBe(2);
      expect(h.sent[1].alerts[0].message).toContain("from 2 to 4 on ip-10-0-0-1");
    });

    it("describes the other alerts when one cannot be described", async function () {
      const report = await check({
        now: NOW,
        lastCheckAt: NOW - 5 * MINUTE,
        client: fakeRedis({ sample: null }),
      });
      report.started = [];
      report.due = {
        restart: {},
        errors: { counts: { ERR: 200 } },
        "tcp-pressure": { from: 1, to: 2 },
      };

      const v = view(report);
      expect(v.alerts.map((a) => a.title)).toEqual([
        "Redis restarted or switched host",
        "Redis errors",
        "TCP memory pressure",
      ]);
      expect(v.alerts[0].message).toContain("could not be described");
      expect(v.alerts[1].message).toContain("ERR 200");
      expect(v.alerts[2].message).toContain("on an unknown host");
    });

    it("starts new counter baselines after a long gap instead of alerting on the difference", async function () {
      const h = harness({ memory: { errors: { OOM: 1, ERR: 5 } } });
      await h.tick();

      h.advance(6 * 60 * MINUTE);
      set(h, { rejected_connections: 40 }, { OOM: 90, ERR: 5000 });
      await h.tick();
      expect(h.sent).toEqual([]);
      expect(h.state.observed.errors).toEqual({ OOM: 90, ERR: 5000 });

      // And counting works again from there
      set(h, { rejected_connections: 41 }, { OOM: 91, ERR: 5000 });
      await h.tick();
      expect(h.sent.length).toBe(1);
      expect(h.sent[0].summary).toBe("Redis rejected connections, Redis refused writes (OOM, MISCONF)");
    });
  });
});
