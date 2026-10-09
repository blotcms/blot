const {
  observe,
  detect,
  merge,
  parseErrors,
  parseSlowlog,
  describeCommand,
  SLOWLOG_ALERT_US,
  FORK_ALERT_US,
} = require("../redis-host-events");

describe("scheduler redis-host-events", function () {
  const info = (lines) => ["run_id:abc", "redis_version:6.2.12", ...lines].join("\r\n");
  const entry = (id, us, ...args) => [id, 1760000000, us, args, "127.0.0.1:1", ""];

  it("reads errorstats", function () {
    expect(
      parseErrors({ errorstat_OOM: "count=3", errorstat_ERR: "count=12", other: "count=1", errorstat_BAD: "x" })
    ).toEqual({ OOM: 3, ERR: 12 });
  });

  it("reads SLOWLOG GET, including Buffer arguments", function () {
    expect(parseSlowlog([[4, 1760000000, 60000, [Buffer.from("GET"), "k"], "c", ""]])).toEqual([
      { id: 4, at: 1760000000000, us: 60000, args: ["GET", "k"] },
    ]);
    expect(parseSlowlog(null)).toEqual([]);
  });

  it("shows the command and two arguments, cut at 100 characters", function () {
    expect(describeCommand(["SET", "k", "v", "never shown"])).toBe("SET k v");
    expect(describeCommand(["EVAL", "x".repeat(300)]).length).toBe(100);
  });

  it("takes a baseline the first time and reports nothing", function () {
    const current = observe(info(["uptime_in_seconds:10", "errorstat_OOM:count=9"]), [entry(5, 900000, "KEYS", "*")]);
    const { events, observed } = detect(null, current);

    expect(events).toEqual({});
    expect(observed.slowlogId).toBe(5);
    expect(observed.errors).toEqual({ OOM: 9 });
  });

  it("reports only what is new and slow enough", function () {
    const before = detect(null, observe(info(["uptime_in_seconds:10"]), [entry(1, 900000, "KEYS", "*")])).observed;
    const now = observe(info(["uptime_in_seconds:310"]), [
      entry(3, SLOWLOG_ALERT_US, "SORT", "k"),
      entry(2, SLOWLOG_ALERT_US - 1, "SORT", "j"),
      entry(1, 900000, "KEYS", "*"),
    ]);
    const { events, observed } = detect(before, now);

    expect(events.slowlog.count).toBe(1);
    expect(events.slowlog.worst[0].command).toBe("SORT k");
    expect(observed.slowlogId).toBe(3);
  });

  it("reports a fork (BGSAVE) only when it is slow enough to matter", function () {
    const before = detect(null, observe(info(["uptime_in_seconds:10"]), [])).observed;
    const now = observe(info(["uptime_in_seconds:310"]), [
      entry(3, FORK_ALERT_US, "BGREWRITEAOF"),
      entry(2, FORK_ALERT_US - 1, "bgsave"),
      entry(1, 84000, "BGSAVE"),
    ]);
    const { events } = detect(before, now);

    expect(events.slowlog.count).toBe(1);
    expect(events.slowlog.worst[0].command).toBe("BGREWRITEAOF");
  });

  it("reports a replica's full sync (PSYNC) only when it is slow enough to matter", function () {
    const before = detect(null, observe(info(["uptime_in_seconds:10"]), [])).observed;
    const now = observe(info(["uptime_in_seconds:310"]), [
      entry(2, FORK_ALERT_US, "PSYNC", "abc", "1"),
      entry(1, FORK_ALERT_US - 1, "PSYNC", "abc", "1"),
    ]);
    const { events } = detect(before, now);

    expect(events.slowlog.count).toBe(1);
    expect(events.slowlog.worst[0].us).toBe(FORK_ALERT_US);
  });

  it("re-baselines the counters when the last look is over 15 minutes old", function () {
    const T = 1760000000000;
    const before = detect(null, observe(info(["uptime_in_seconds:10", "errorstat_OOM:count=1", "rejected_connections:0"]), []), { now: T }).observed;
    const later = observe(info(["uptime_in_seconds:20000", "errorstat_OOM:count=50", "rejected_connections:9"]), []);

    expect(detect(before, later, { now: T + 5 * 60 * 1000 }).events["errors-critical"]).toEqual({ counts: { OOM: 49 } });
    expect(detect(before, later, { now: T + 5 * 60 * 1000 }).events.rejected).toEqual({ count: 9 });

    const long = detect(before, later, { now: T + 6 * 60 * 60 * 1000 });
    expect(long.events).toEqual({});
    expect(long.observed.errors).toEqual({ OOM: 50 });
    expect(long.observed.at).toBe(T + 6 * 60 * 60 * 1000);
  });

  it("merges pending events", function () {
    expect(merge.errors({ counts: { A: 1 } }, { counts: { A: 2, B: 5 } })).toEqual({ counts: { A: 3, B: 5 } });
    expect(merge["tcp-pressure"]({ from: 1, to: 2 }, { from: 2, to: 5 })).toEqual({ from: 1, to: 5 });

    const worst = (n) => Array.from({ length: n }, (_, i) => ({ us: i, at: 0, command: "c" }));
    const merged = merge.slowlog({ count: 8, worst: worst(8) }, { count: 6, worst: worst(6) });
    expect(merged.count).toBe(14);
    expect(merged.worst.length).toBe(10);
    expect(merged.worst[0].us).toBe(7);
  });
});
