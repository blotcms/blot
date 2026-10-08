describe("scheduler check-redis-host", function () {
  const run = require("../check-redis-host");
  const { check, view, parseSample, parseMemory, SAMPLE_KEY, STATE_KEY } = run;

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

  function info({ used = 1 * GB, maxmemory = 10 * GB, notCounted = 0 } = {}) {
    return [
      "# Memory",
      `used_memory:${used}`,
      "used_memory_human:1.00G",
      `maxmemory:${maxmemory}`,
      "maxmemory_policy:noeviction",
      `mem_not_counted_for_evict:${notCounted}`,
      "",
    ].join("\r\n");
  }

  // The parts of the Redis client the check uses
  function fakeRedis({ sample = sampleLine(), memory = {} } = {}) {
    const store = new Map();
    if (sample !== null) store.set(SAMPLE_KEY, sample);
    const redis = {
      store,
      memory,
      sendCommand: async ([command, ...args]) => {
        if (command === "GET") return store.has(args[0]) ? store.get(args[0]) : null;
        if (command === "SET") return store.set(args[0], args[1]) && "OK";
        if (command === "INFO") {
          expect(args).toEqual(["memory"]);
          return info(redis.memory);
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
          " disk_root=256000000/1024000000 disk_backups=512000000/2048000000"
      );

      expect(sample.mem).toBe(100);
      expect(sample.active).toBe(true);
      expect(sample.ramTotal).toBe(16384000000);
      expect(sample.ramAvailable).toBe(12288000000);
      expect(sample.diskRoot).toEqual({ used: 256000000, total: 1024000000 });
      expect(sample.diskBackups).toEqual({ used: 512000000, total: 2048000000 });
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
      ]);
      expect(v.thresholds).toEqual({ tcpMem: "50%", maxmemory: "80%", stale: "20 minutes" });
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
});
