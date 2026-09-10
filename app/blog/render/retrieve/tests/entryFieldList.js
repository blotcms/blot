var entryFieldList = require("../helpers/entryFieldList");

describe("retrieve/entryFieldList", function () {
  it("returns null for legacy boolean metadata", function () {
    expect(entryFieldList({ allEntries: true }, ["allEntries"])).toBe(null);
  });

  it("returns null for non-field access like allEntries.length", function () {
    expect(
      entryFieldList({ allEntries: { length: true } }, ["allEntries"])
    ).toBe(null);
  });

  it("returns every non-heavy field but no heavy field when none is referenced", function () {
    var fields = entryFieldList(
      { allEntries: { fields: { title: true, url: true } } },
      ["allEntries", "all_entries"]
    );

    expect(fields).toContain("title");
    expect(fields).toContain("url");
    expect(fields).toContain("dateStamp");
    expect(fields).toContain("metadata");
    expect(fields).not.toContain("html");
    expect(fields).not.toContain("body");
    expect(fields).not.toContain("summary");
  });

  it("adds a heavy field when the view references it", function () {
    var fields = entryFieldList(
      { allEntries: { fields: { title: true, html: true } } },
      ["allEntries"]
    );

    expect(fields).toContain("html");
    expect(fields).not.toContain("body");
  });

  it("merges references across aliases", function () {
    var fields = entryFieldList(
      {
        allEntries: { fields: { title: true } },
        all_entries: { fields: { summary: true } },
      },
      ["allEntries", "all_entries"]
    );

    expect(fields).toContain("summary");
  });
});
