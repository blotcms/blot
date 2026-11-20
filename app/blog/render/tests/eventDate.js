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
});
