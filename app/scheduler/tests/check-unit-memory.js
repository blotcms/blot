describe("scheduler check-unit-memory", function () {
  const run = require("../check-unit-memory");
  const { check, view, parseSample, SAMPLE_KEY, STATE_KEY, OOM_MIN_INTERVAL } =
    run;

  const MINUTE = 60 * 1000;
  const MiB = 1024 * 1024;
  const NOW = Date.UTC(2026, 10, 19, 12, 2);
  const LIMIT = 1000 * MiB;

  const stamp = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

  // A line as config/host/scripts/unit-mem-log.sh stores it
  const line = (
    name,
    { time = NOW - MINUTE, anon = 400, shmem = 0, oom = 0 }
  ) =>
    `${stamp(time)} name=${name} anon=${anon * MiB} shmem=${shmem * MiB} ` +
    `limit=${LIMIT} oom_kill=${oom}`;

  // units: { name: options for line() }
  const sampleOf = (units) =>
    Object.keys(units)
      .map((name) => line(name, units[name]))
      .join("\n") + "\n";

  const healthy = () => ({
    "blot-blue": {},
    "blot-green": {},
    "blot-sandbox-blue": {},
  });

  function fakeRedis(units = healthy()) {
    const store = new Map([[SAMPLE_KEY, sampleOf(units)]]);
    return {
      store,
      sendCommand: async ([command, ...args]) => {
        if (command === "GET")
          return store.has(args[0]) ? store.get(args[0]) : null;
        if (command === "SET") return store.set(args[0], args[1]) && "OK";
        throw new Error("unexpected command " + command);
      },
    };
  }

  // Runs the check like the scheduler, 5 minutes apart. Each tick writes a
  // sample taken a minute before it, as the sampler would.
  function harness(units) {
    const client = fakeRedis(units);
    const sent = [];
    let now = NOW;

    return {
      client,
      sent,
      sample: (next) => client.store.set(SAMPLE_KEY, sampleOf(next)),
      get state() {
        return JSON.parse(client.store.get(STATE_KEY) || "null");
      },
      get now() {
        return now;
      },
      // Writes a sample from a minute ago with these units, then checks
      tick: async (next) => {
        if (next) {
          const shifted = {};
          Object.keys(next).forEach(
            (name) => (shifted[name] = { time: now - MINUTE, ...next[name] })
          );
          client.store.set(SAMPLE_KEY, sampleOf(shifted));
        }
        const result = await run({
          now,
          client,
          sendEmail: async (v) => sent.push(v),
        });
        now += 5 * MINUTE;
        return result;
      },
      advance: (ms) => (now += ms),
    };
  }

  const titles = (v) => v.alerts.map((a) => a.title);

  describe("parsing", function () {
    it("reads the lines the sampler stores", function () {
      expect(
        parseSample(sampleOf({ "blot-blue": { anon: 10, shmem: 2, oom: 3 } }))
      ).toEqual({
        time: NOW - MINUTE,
        containers: {
          "blot-blue": {
            anon: 10 * MiB,
            shmem: 2 * MiB,
            limit: LIMIT,
            oom: 3,
          },
        },
      });
    });

    it("skips lines it can't read and gives up when none can be", function () {
      expect(parseSample(null)).toBe(null);
      expect(parseSample("garbage\n\nname=x")).toBe(null);
      const sample = parseSample(
        "garbage\n" + line("blot-blue", {}) + "\n" + stamp(NOW) + " name=a"
      );
      expect(Object.keys(sample.containers)).toEqual(["blot-blue"]);
    });
  });

  describe("quiet when healthy", function () {
    it("sends nothing and saves a baseline", async function () {
      const h = harness();
      const { sent } = await h.tick();

      expect(sent).toBe(false);
      expect(h.sent).toEqual([]);
      expect(h.state.oom["blot-blue"].count).toBe(0);
    });

    it("says nothing where the sampler is not installed", async function () {
      const h = harness();
      h.client.store.delete(SAMPLE_KEY);

      for (let i = 0; i < 4; i++) await h.tick();

      expect(h.sent).toEqual([]);
    });
  });

  describe("oom_kill", function () {
    it("does not alert on a count it sees for the first time", async function () {
      const h = harness({ "blot-blue": { oom: 7 } });
      await h.tick();

      expect(h.sent).toEqual([]);
    });

    it("alerts when a unit's counter rises", async function () {
      const h = harness();
      await h.tick();
      await h.tick({ ...healthy(), "blot-blue": { oom: 2 } });

      expect(h.sent.length).toBe(1);
      expect(titles(h.sent[0])).toEqual(["blot-blue out of memory"]);
      expect(h.sent[0].alerts[0].message).toContain("rose from 0 to 2");
      expect(h.sent[0].summary).toContain("blot-blue out of memory");
    });

    it("alerts for a sandbox cgroup, and names it", async function () {
      const h = harness();
      await h.tick();
      await h.tick({ ...healthy(), "blot-sandbox-blue": { oom: 1 } });

      expect(titles(h.sent[0])).toEqual(["blot-sandbox-blue out of memory"]);
    });

    it("alerts once for a rise, not again while the count is steady", async function () {
      const h = harness();
      await h.tick();
      const units = { ...healthy(), "blot-blue": { oom: 1 } };
      await h.tick(units);
      await h.tick(units);
      await h.tick(units);

      expect(h.sent.length).toBe(1);
    });

    it("holds a second rise back for an hour and counts both", async function () {
      const h = harness();
      await h.tick();
      await h.tick({ ...healthy(), "blot-blue": { oom: 1 } });
      await h.tick({ ...healthy(), "blot-blue": { oom: 3 } });

      expect(h.sent.length).toBe(1);

      h.advance(OOM_MIN_INTERVAL);
      await h.tick({ ...healthy(), "blot-blue": { oom: 3 } });

      expect(h.sent.length).toBe(2);
      expect(h.sent[1].alerts[0].message).toContain("rose from 1 to 3");
    });

    it("treats a lower count as a replaced container, not an alert", async function () {
      const h = harness({ "blot-blue": { oom: 5 } });
      await h.tick();
      await h.tick({ ...healthy(), "blot-blue": { oom: 0 } });

      expect(h.sent).toEqual([]);
      expect(h.state.oom["blot-blue"].count).toBe(0);

      h.advance(OOM_MIN_INTERVAL);
      await h.tick({ ...healthy(), "blot-blue": { oom: 1 } });

      expect(h.sent.length).toBe(1);
    });

    it("counts a kill in a cgroup that appeared since the last check", async function () {
      const h = harness({ "blot-blue": {} });
      await h.tick();
      await h.tick({ "blot-blue": {}, "blot-sandbox-green": { oom: 1 } });

      expect(titles(h.sent[0])).toEqual(["blot-sandbox-green out of memory"]);
    });

    it("lists every cgroup that rose in one email", async function () {
      const h = harness();
      await h.tick();
      await h.tick({
        "blot-blue": { oom: 1 },
        "blot-green": { oom: 1 },
        "blot-sandbox-blue": {},
      });

      expect(h.sent.length).toBe(1);
      expect(titles(h.sent[0]).length).toBe(2);
    });
  });

  describe("memory near the limit", function () {
    it("alerts over 85% of the limit in anon+shmem", async function () {
      const h = harness();
      await h.tick();
      await h.tick({ ...healthy(), "blot-blue": { anon: 800, shmem: 60 } });

      expect(h.sent.length).toBe(1);
      expect(titles(h.sent[0])).toEqual(["blot-blue memory near its limit"]);
      expect(h.sent[0].alerts[0].message).toContain("86%");
    });

    it("is under the line just under 85%", async function () {
      const h = harness();
      await h.tick();
      await h.tick({ ...healthy(), "blot-blue": { anon: 849 } });

      expect(h.sent).toEqual([]);
    });

    it("alerts once, stays quiet while high, and emails when it clears", async function () {
      const h = harness();
      await h.tick();
      const high = { ...healthy(), "blot-blue": { anon: 900 } };
      await h.tick(high);
      await h.tick(high);
      await h.tick(high);

      expect(h.sent.length).toBe(1);

      // Between 80% and 85% it is still on
      await h.tick({ ...healthy(), "blot-blue": { anon: 820 } });
      expect(h.sent.length).toBe(1);

      await h.tick({ ...healthy(), "blot-blue": { anon: 500 } });

      expect(h.sent.length).toBe(2);
      expect(h.sent[1].hasAlerts).toBe(false);
      expect(h.sent[1].recovered.map((r) => r.title)).toEqual([
        "blot-blue memory near its limit",
      ]);
      expect(h.sent[1].summary).toContain("recovered");

      // And it can start again
      await h.tick(high);
      expect(h.sent.length).toBe(3);
    });

    it("judges each unit on its own", async function () {
      const h = harness();
      await h.tick();
      await h.tick({
        ...healthy(),
        "blot-blue": { anon: 900 },
        "blot-green": { anon: 950 },
      });

      expect(titles(h.sent[0]).sort()).toEqual([
        "blot-blue memory near its limit",
        "blot-green memory near its limit",
      ]);
    });

    it("leaves sandbox cgroups out, since their jobs are short", async function () {
      const h = harness();
      await h.tick();
      await h.tick({ ...healthy(), "blot-sandbox-blue": { anon: 990 } });

      expect(h.sent).toEqual([]);
    });

    it("ignores a unit with no limit", async function () {
      const h = harness();
      await h.tick();
      h.client.store.set(
        SAMPLE_KEY,
        `${stamp(h.now - MINUTE)} name=blot-blue anon=${5000 * MiB} shmem=0 limit=0 oom_kill=0\n`
      );
      await h.tick();

      expect(h.sent).toEqual([]);
    });

    it("clears when the unit has gone", async function () {
      const h = harness();
      await h.tick();
      await h.tick({ ...healthy(), "blot-blue": { anon: 900 } });
      await h.tick({ "blot-green": {} });

      expect(h.sent.length).toBe(2);
      expect(h.sent[1].recovered.length).toBe(1);
    });
  });

  describe("stale sample", function () {
    it("alerts when the sample is over 10 minutes old on two checks in a row", async function () {
      const h = harness();
      await h.tick();
      // The sampler stops: the key keeps the sample from the first tick
      await h.tick();
      expect(h.sent).toEqual([]);

      h.advance(10 * MINUTE);
      await h.tick(); // first stale check
      expect(h.sent).toEqual([]);

      await h.tick(); // second
      expect(h.sent.length).toBe(1);
      expect(titles(h.sent[0])).toEqual(["Unit memory sample stale"]);
      expect(h.sent[0].alerts[0].message).toContain("minutes old");
    });

    it("alerts once, then emails when the sampler is back", async function () {
      const h = harness();
      await h.tick();
      h.advance(20 * MINUTE);
      await h.tick();
      await h.tick();
      await h.tick();
      await h.tick();

      expect(h.sent.length).toBe(1);

      await h.tick(healthy());

      expect(h.sent.length).toBe(2);
      expect(h.sent[1].recovered.map((r) => r.title)).toEqual([
        "Unit memory sample stale",
      ]);
    });

    it("does not alert on one old reading, such as after Redis was away", async function () {
      const h = harness();
      await h.tick();
      h.advance(30 * MINUTE);
      await h.tick();
      await h.tick(healthy());

      expect(h.sent).toEqual([]);
    });

    it("does not judge memory or kills from a stale sample", async function () {
      const h = harness();
      await h.tick();
      h.advance(20 * MINUTE);
      h.client.store.set(
        SAMPLE_KEY,
        sampleOf({
          "blot-blue": { time: h.now - 15 * MINUTE, anon: 990, oom: 4 },
        })
      );
      await h.tick();
      await h.tick();

      expect(titles(h.sent[0])).toEqual(["Unit memory sample stale"]);
      expect(h.sent.length).toBe(1);
    });
  });

  describe("state", function () {
    it("does not email when a send fails, and tries again", async function () {
      const h = harness();
      await h.tick();
      h.client.store.set(
        SAMPLE_KEY,
        sampleOf({ "blot-blue": { time: h.now - MINUTE, oom: 1 } })
      );

      await expectAsync(
        run({
          now: h.now,
          client: h.client,
          sendEmail: async () => {
            throw new Error("smtp down");
          },
        })
      ).toBeRejectedWithError("smtp down");

      await h.tick();
      expect(h.sent.length).toBe(1);
    });

    it("keeps the state it could not write and does not email twice", async function () {
      const h = harness();
      await h.tick();
      const keep = { state: null };
      const set = h.client.sendCommand;
      h.client.sendCommand = async (args) => {
        if (args[0] === "SET") throw new Error("OOM command not allowed");
        return set(args);
      };
      h.client.store.set(
        SAMPLE_KEY,
        sampleOf({ "blot-blue": { time: h.now - MINUTE, oom: 1 } })
      );
      spyOn(console, "log");
      const sent = [];
      const options = {
        client: h.client,
        keep,
        sendEmail: async (v) => sent.push(v),
      };

      await run({ ...options, now: h.now });
      await run({ ...options, now: h.now + 5 * MINUTE });

      expect(sent.length).toBe(1);
    });

    it("treats an unreadable state as a fresh start", async function () {
      const h = harness({ "blot-blue": { oom: 3 } });
      h.client.store.set(STATE_KEY, "{not json");
      const report = await check({ now: NOW, client: h.client });

      expect(report.send).toBe(false);
    });

    it("renders every alert through view()", async function () {
      const h = harness();
      await h.tick();
      const { report } = await h.tick({
        "blot-blue": { anon: 900, oom: 1 },
        "blot-green": {},
      });
      const v = view(report);

      expect(v.hasAlerts).toBe(true);
      expect(v.readings.length).toBeGreaterThan(1);
      expect(v.thresholds.memory).toBe("85%");
    });
  });
});
