describe("clients/util modifiedSince", function () {
  const modifiedSince = require("../modifiedSince");
  const cutoff = Date.parse("2026-09-19T16:00:00Z");

  it("is true for timestamps at or after the cutoff", function () {
    expect(modifiedSince("2026-09-19T16:00:00Z", cutoff)).toEqual(true);
    expect(modifiedSince("2026-09-19T16:00:05Z", cutoff)).toEqual(true);
  });

  it("is true within the grace period just before the cutoff", function () {
    expect(modifiedSince("2026-09-19T15:59:57Z", cutoff)).toEqual(true);
  });

  it("is false for timestamps well before the cutoff", function () {
    expect(modifiedSince("2026-09-19T15:30:00Z", cutoff)).toEqual(false);
  });

  it("accepts a numeric timestamp as well as a parseable string", function () {
    expect(modifiedSince(cutoff + 1000, cutoff)).toEqual(true);
    expect(modifiedSince(cutoff - 60 * 1000, cutoff)).toEqual(false);
  });

  it("is false for missing or unparseable timestamps", function () {
    expect(modifiedSince(undefined, cutoff)).toEqual(false);
    expect(modifiedSince("not a date", cutoff)).toEqual(false);
  });

  it("excludes nothing when no cutoff is given (older callers)", function () {
    expect(modifiedSince("2026-09-19T16:00:05Z", undefined)).toEqual(false);
    expect(modifiedSince("2026-09-19T16:00:05Z", 0)).toEqual(false);
  });
});
