describe("getTemplateSortOptions", function () {
  const getTemplateSortOptions = require("../sortOptions");

  it("reads flat sort_by and sort_order locals", function () {
    expect(
      getTemplateSortOptions({ sort_by: "id", sort_order: "desc" })
    ).toEqual({ sortBy: "id", order: "desc" });
  });

  it("prefers nested sort.by and sort.direction", function () {
    expect(
      getTemplateSortOptions({
        sort: { by: "id", direction: "desc" },
        sort_by: "date",
        sort_order: "asc"
      })
    ).toEqual({ sortBy: "id", order: "desc" });
  });

  it("accepts nested sort.order as an alias for direction", function () {
    expect(getTemplateSortOptions({ sort: { by: "id", order: "asc" } })).toEqual(
      { sortBy: "id", order: "asc" }
    );
  });

  it("returns undefined fields when locals are missing", function () {
    expect(getTemplateSortOptions()).toEqual({
      sortBy: undefined,
      order: undefined
    });
    expect(getTemplateSortOptions({})).toEqual({
      sortBy: undefined,
      order: undefined
    });
  });
});

describe("sortEntries / sortEntryIDs", function () {
  const { sortEntries, sortEntryIDs, isNewestFirst } = require("../sortOptions");

  // Newest-first by dateStamp is the natural order tag sets and recent_entries
  // already return.
  const newestFirst = [
    { id: "c.txt", dateStamp: 30 },
    { id: "a.txt", dateStamp: 20 },
    { id: "b.txt", dateStamp: 10 }
  ];

  const ids = entries => entries.map(entry => entry.id);

  it("leaves newest-first order untouched for the default selection", function () {
    expect(ids(sortEntries(newestFirst, {}))).toEqual(["c.txt", "a.txt", "b.txt"]);
    expect(ids(sortEntries(newestFirst, { sortBy: "date", order: "asc" }))).toEqual(
      ["c.txt", "a.txt", "b.txt"]
    );
    expect(isNewestFirst({})).toBe(true);
    expect(isNewestFirst({ sortBy: "date", order: "asc" })).toBe(true);
  });

  it("flips to oldest-first for date + desc", function () {
    expect(ids(sortEntries(newestFirst, { sortBy: "date", order: "desc" }))).toEqual(
      ["b.txt", "a.txt", "c.txt"]
    );
    expect(isNewestFirst({ sortBy: "date", order: "desc" })).toBe(false);
  });

  it("sorts by file path for id + asc / desc", function () {
    expect(ids(sortEntries(newestFirst, { sortBy: "id", order: "asc" }))).toEqual(
      ["a.txt", "b.txt", "c.txt"]
    );
    expect(ids(sortEntries(newestFirst, { sortBy: "id", order: "desc" }))).toEqual(
      ["c.txt", "b.txt", "a.txt"]
    );
  });

  it("breaks equal-dateStamp ties by id, matching the Redis listing", function () {
    const sameDate = [
      { id: "b.txt", dateStamp: 10 },
      { id: "a.txt", dateStamp: 10 },
      { id: "c.txt", dateStamp: 10 }
    ];
    // newest-first: ties fall to descending id (like ZRANGE REV)
    expect(ids(sortEntries(sameDate, { sortBy: "date", order: "asc" }))).toEqual([
      "c.txt",
      "b.txt",
      "a.txt"
    ]);
    // oldest-first: ties fall to ascending id (like ZRANGE)
    expect(ids(sortEntries(sameDate, { sortBy: "date", order: "desc" }))).toEqual([
      "a.txt",
      "b.txt",
      "c.txt"
    ]);
  });

  it("does not mutate the input array", function () {
    const input = newestFirst.slice();
    sortEntries(input, { sortBy: "id", order: "asc" });
    expect(ids(input)).toEqual(["c.txt", "a.txt", "b.txt"]);
  });

  it("orders an ID-only list that arrived newest-first", function () {
    const list = ["c.txt", "a.txt", "b.txt"];
    expect(sortEntryIDs(list, {})).toEqual(["c.txt", "a.txt", "b.txt"]);
    expect(sortEntryIDs(list, { sortBy: "date", order: "desc" })).toEqual([
      "b.txt",
      "a.txt",
      "c.txt"
    ]);
    expect(sortEntryIDs(list, { sortBy: "id", order: "asc" })).toEqual([
      "a.txt",
      "b.txt",
      "c.txt"
    ]);
    expect(sortEntryIDs(list, { sortBy: "id", order: "desc" })).toEqual([
      "c.txt",
      "b.txt",
      "a.txt"
    ]);
  });
});
