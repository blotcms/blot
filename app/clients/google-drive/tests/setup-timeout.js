describe("google drive setup timeout", function () {
  const { timedOut } = require("../routes/setup");
  const HOUR = 60 * 60 * 1000;
  const now = Date.now();

  it("counts a setup started over two hours ago as timed out", function () {
    expect(timedOut({ startedSetup: now - 3 * HOUR }, now)).toBe(true);
    // A start time stored as a string still counts
    expect(timedOut({ startedSetup: String(now - 3 * HOUR) }, now)).toBe(true);
  });

  it("leaves a recent setup, or one with no start time, to run", function () {
    expect(timedOut({ startedSetup: now - HOUR }, now)).toBe(false);
    expect(timedOut({}, now)).toBe(false);
    expect(timedOut(null, now)).toBe(false);
  });
});
