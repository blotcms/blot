describe("dropbox modifiedSince", function () {
  const modifiedSince = require("../sync/modified-since");
  const start = Date.parse("2026-09-19T16:00:00Z");

  it("is true for files modified after the cutoff", function () {
    expect(
      modifiedSince({ server_modified: "2026-09-19T16:00:05Z" }, start)
    ).toEqual(true);
  });

  it("is true for files modified just before the cutoff", function () {
    expect(
      modifiedSince({ server_modified: "2026-09-19T15:59:57Z" }, start)
    ).toEqual(true);
  });

  it("is false for older files and missing timestamps", function () {
    expect(
      modifiedSince({ server_modified: "2026-09-19T15:30:00Z" }, start)
    ).toEqual(false);
    expect(modifiedSince({}, start)).toEqual(false);
  });
});
