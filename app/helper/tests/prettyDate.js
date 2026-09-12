describe("prettyDate", function () {
  const prettyDate = require("helper/prettyDate");

  it("formats a date object", function () {
    const date = new Date(2023, 0, 15);
    expect(prettyDate(date)).toBe("January 15, 2023");
  });

  it("formats a date string", function () {
    // Use a local-time (non-"Z"/offset) ISO string so this doesn't depend on
    // the test runner's timezone: a date-only string like "2023-06-20" is
    // parsed as UTC midnight, which prettyDate (using local-time getters)
    // can render as the previous day in timezones behind UTC.
    expect(prettyDate("2023-06-20T12:00:00")).toBe("June 20, 2023");
  });

  it("formats a timestamp", function () {
    const timestamp = new Date(2023, 11, 25).getTime();
    expect(prettyDate(timestamp)).toBe("December 25, 2023");
  });

  it("handles all months correctly", function () {
    expect(prettyDate(new Date(2023, 0, 1))).toContain("January");
    expect(prettyDate(new Date(2023, 1, 1))).toContain("February");
    expect(prettyDate(new Date(2023, 2, 1))).toContain("March");
    expect(prettyDate(new Date(2023, 3, 1))).toContain("April");
    expect(prettyDate(new Date(2023, 4, 1))).toContain("May");
    expect(prettyDate(new Date(2023, 5, 1))).toContain("June");
    expect(prettyDate(new Date(2023, 6, 1))).toContain("July");
    expect(prettyDate(new Date(2023, 7, 1))).toContain("August");
    expect(prettyDate(new Date(2023, 8, 1))).toContain("September");
    expect(prettyDate(new Date(2023, 9, 1))).toContain("October");
    expect(prettyDate(new Date(2023, 10, 1))).toContain("November");
    expect(prettyDate(new Date(2023, 11, 1))).toContain("December");
  });

  it("handles single digit days", function () {
    const date = new Date(2023, 0, 5);
    expect(prettyDate(date)).toBe("January 5, 2023");
  });

  it("handles double digit days", function () {
    const date = new Date(2023, 0, 31);
    expect(prettyDate(date)).toBe("January 31, 2023");
  });

  it("handles different years", function () {
    expect(prettyDate(new Date(2000, 0, 1))).toContain("2000");
    expect(prettyDate(new Date(1999, 0, 1))).toContain("1999");
    expect(prettyDate(new Date(2030, 0, 1))).toContain("2030");
  });

  it("handles leap year date", function () {
    const date = new Date(2024, 1, 29);
    expect(prettyDate(date)).toBe("February 29, 2024");
  });
});
