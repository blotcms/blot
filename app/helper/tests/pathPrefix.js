const {
  normalizePathPrefix,
  filterEntryIDsByPathPrefix,
} = require("helper/pathPrefix");

describe("pathPrefix helper", function () {
  it("normalizes prefixes with missing slash and trims whitespace", function () {
    expect(normalizePathPrefix(" blog/")).toBe("/blog/");
  });

  it("returns null for empty or whitespace-only prefixes", function () {
    expect(normalizePathPrefix("")).toBeNull();
    expect(normalizePathPrefix("   ")).toBeNull();
  });

  it("filters IDs by normalized prefix and ignores non-string IDs", function () {
    expect(
      filterEntryIDsByPathPrefix(
        ["/blog/a.txt", 3, null, "/notes/b.txt"],
        "blog/"
      )
    ).toEqual(["/blog/a.txt"]);
  });
});
