const eventDate = require("../load/eventDate");

describe("eventDate", function () {
  const zone = "America/New_York";

  it("reads a date and time in the blog's time zone", function () {
    const parsed = eventDate({ event: "2026-12-08 18:30" }, zone);
    expect(parsed.allDay).toBe(false);
    expect(new Date(parsed.stamp).toISOString()).toEqual(
      "2026-12-08T23:30:00.000Z"
    );
  });

  it("reads a date alone as a whole day", function () {
    const parsed = eventDate({ event: "2027-02-20" }, zone);
    expect(parsed.allDay).toBe(true);
  });

  it("ignores a line that isn't a date", function () {
    expect(eventDate({ event: "Tuesday, December 8" }, zone)).toBe(null);
    expect(eventDate({}, zone)).toBe(null);
    expect(eventDate(undefined, zone)).toBe(null);
  });

  it("counts a timed event as upcoming until it starts", function () {
    const parsed = eventDate({ event: "2026-12-08 18:30" }, zone);
    expect(eventDate.isUpcoming(parsed, parsed.stamp - 1, zone)).toBe(true);
    expect(eventDate.isUpcoming(parsed, parsed.stamp + 1, zone)).toBe(false);
  });

  it("counts a whole-day event as upcoming until the day ends", function () {
    const parsed = eventDate({ event: "2027-02-20" }, zone);
    const evening = parsed.stamp + 20 * 60 * 60 * 1000;
    const nextDay = parsed.stamp + 25 * 60 * 60 * 1000;
    expect(eventDate.isUpcoming(parsed, evening, zone)).toBe(true);
    expect(eventDate.isUpcoming(parsed, nextDay, zone)).toBe(false);
  });

  it("finds the next occurrence of a monthly event on the same weekday", function () {
    const parsed = eventDate(
      { event: "2026-01-13 18:30", repeats: "monthly" },
      "UTC"
    );
    const next = eventDate.next(
      parsed,
      Date.parse("2026-11-20T00:00:00Z"),
      "UTC"
    );
    expect(new Date(next).toISOString()).toEqual("2026-12-08T18:30:00.000Z");
    expect(eventDate.rrule(parsed, "UTC")).toEqual("FREQ=MONTHLY;BYDAY=2TU");
  });

  it("falls back to the last weekday in a month without a fifth", function () {
    const parsed = eventDate(
      { event: "2026-01-29 10:00", repeats: "monthly" },
      "UTC"
    );
    const next = eventDate.next(
      parsed,
      Date.parse("2026-02-01T00:00:00Z"),
      "UTC"
    );
    expect(new Date(next).toISOString()).toEqual("2026-02-26T10:00:00.000Z");
  });

  it("stops repeating after Until", function () {
    const parsed = eventDate(
      { event: "2026-11-01 10:00", repeats: "weekly", until: "2026-11-15" },
      "UTC"
    );
    expect(
      eventDate.next(parsed, Date.parse("2026-11-20T00:00:00Z"), "UTC")
    ).toBe(null);
    expect(eventDate.rrule(parsed, "UTC")).toContain("UNTIL=20261115");
  });

  it("keeps a multi-day event upcoming until its last day ends", function () {
    const parsed = eventDate(
      { event: "2027-02-20", ends: "2027-02-21" },
      "UTC"
    );
    expect(
      eventDate.isUpcoming(parsed, Date.parse("2027-02-21T20:00:00Z"), "UTC")
    ).toBe(true);
    expect(
      eventDate.isUpcoming(parsed, Date.parse("2027-02-22T01:00:00Z"), "UTC")
    ).toBe(false);
  });

  it("reads its lines in any case", function () {
    const parsed = eventDate(
      { EVENT: "2026-12-08", REPEATS: "Weekly", UNTIL: "2026-12-31" },
      "UTC"
    );
    expect(parsed.allDay).toBe(true);
    expect(parsed.repeats).toEqual("weekly");
    expect(parsed.until).toBeDefined();
  });

  it("keeps a repeating multi-day event's length each time", function () {
    const parsed = eventDate(
      { event: "2026-11-07", ends: "2026-11-08", repeats: "weekly" },
      "UTC"
    );
    const now = Date.parse("2026-11-15T12:00:00Z");
    const next = eventDate.next(parsed, now, "UTC");
    expect(new Date(next).toISOString()).toEqual("2026-11-14T00:00:00.000Z");
    expect(
      new Date(eventDate.endsOn(parsed, next, "UTC")).toISOString()
    ).toEqual("2026-11-15T00:00:00.000Z");
  });

  it("changes just after the occurrence it shows ends", function () {
    const parsed = eventDate(
      { event: "2027-02-20", ends: "2027-02-21" },
      "UTC"
    );
    expect(
      eventDate.nextChange(parsed, Date.parse("2027-02-01T00:00:00Z"), "UTC")
    ).toEqual(Date.parse("2027-02-22T00:00:00Z"));
    expect(
      eventDate.nextChange(parsed, Date.parse("2027-03-01T00:00:00Z"), "UTC")
    ).toBe(null);
  });

  it("writes a fifth weekday as the last in the calendar rule", function () {
    const parsed = eventDate(
      { event: "2026-01-29 10:00", repeats: "monthly" },
      "UTC"
    );
    expect(eventDate.rrule(parsed, "UTC")).toEqual("FREQ=MONTHLY;BYDAY=-1TH");
  });
});
