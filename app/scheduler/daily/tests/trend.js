describe("scheduler/daily/trend", function () {
  const { parse, record, trend, status, MAX_POINTS } = require("../trend");

  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const GB = 1024 * 1024 * 1024;
  const NOW = Date.UTC(2026, 9, 22, 7, 0);

  it("reads a stored history, ignoring what is not one", function () {
    expect(parse(null)).toEqual([]);
    expect(parse("garbage")).toEqual([]);
    expect(parse('{"time":1}')).toEqual([]);
    expect(parse('[{"time":5,"used":7},{"time":0,"used":1},null,{"time":5}]')).toEqual([{ time: 5, used: 7 }]);
  });

  it("adds a reading unless the last is within the hour, and keeps the last week", function () {
    const first = record([], { time: NOW, used: 1 });
    expect(first).toEqual([{ time: NOW, used: 1 }]);
    expect(record(first, { time: NOW + 10 * 60 * 1000, used: 2 })).toBe(first);

    let history = [];
    for (let day = 0; day < 12; day++) history = record(history, { time: NOW + day * DAY, used: day, scope: "a" });
    expect(history.length).toBe(MAX_POINTS);
    expect(history[history.length - 1]).toEqual({ time: NOW + 11 * DAY, used: 11, scope: "a" });
  });

  describe("trend", function () {
    const args = (history, used = 10 * GB) => ({ history, now: NOW, used, limit: 20 * GB });

    it("is empty without an earlier reading to compare with", function () {
      expect(trend(args([]))).toBe("");
      expect(trend(args([{ time: NOW - 10 * 60 * 1000, used: 9 * GB }]))).toBe("");
      expect(trend(args([{ time: NOW - 8 * DAY, used: 9 * GB }]))).toBe("");
    });

    it("projects the days to the limit from the oldest reading in the week", function () {
      expect(trend(args([{ time: NOW - DAY, used: 9 * GB }]))).toBe("resize in ~10 days");
      expect(trend({ ...args([{ time: NOW - 2 * DAY, used: 8 * GB }]), action: "grow" })).toBe("grow in ~10 days");
    });

    it("says stable when flat, shrinking or over a year away", function () {
      expect(trend(args([{ time: NOW - DAY, used: 10 * GB }]))).toBe("stable");
      expect(trend(args([{ time: NOW - DAY, used: 11 * GB }]))).toBe("stable");
      expect(trend(args([{ time: NOW - DAY, used: 10 * GB - 20 * 1024 * 1024 }]))).toBe("stable");
    });

    it("ignores readings of another scope", function () {
      const history = [{ time: NOW - DAY, used: 1 * GB, scope: "old-host" }];
      expect(trend({ ...args(history), scope: "new-host" })).toBe("");
      expect(trend({ ...args(history), scope: "old-host" })).toBe("resize in ~1 days");
    });

    it("says what to do once the limit is reached", function () {
      expect(trend(args([], 20 * GB))).toBe("resize now");
      expect(trend({ ...args([], 21 * GB), action: "grow" })).toBe("grow now");
      expect(trend({ ...args([], 21 * GB), over: "**[go](x)**" })).toBe("**[go](x)**");
    });
  });

  it("formats the status", function () {
    expect(status({ percent: "19%", free: 22 * GB, trend: "stable" })).toBe("19% (stable, 22 GB free)");
    expect(status({ percent: "19%", free: 22 * GB, trend: "" })).toBe("19% (22 GB free)");
  });
});
