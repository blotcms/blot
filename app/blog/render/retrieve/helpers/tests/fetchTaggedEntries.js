describe("fetchTaggedEntries sort ordering", function () {
  const Tags = require("models/tags");
  const fetchTaggedEntries = require("../fetchTaggedEntries");

  // The tag's sorted set is scored by dateStamp; Redis reads it newest-first
  // with REV, or oldest-first with rev:false. Model that here.
  const NEWEST_FIRST = ["d.txt", "c.txt", "b.txt", "a.txt"];
  let lastTagOptions;

  function stubTag(newestFirstIds) {
    lastTagOptions = undefined;
    spyOn(Tags, "get").and.callFake(function (blogID, slug, options, callback) {
      if (typeof options === "function") {
        callback = options;
        options = undefined;
      }
      options = options || {};
      lastTagOptions = options;

      let list = newestFirstIds.slice();
      if (options.rev === false) list.reverse(); // oldest-first
      if (options.limit !== undefined) {
        const start = options.offset || 0;
        list = list.slice(start, start + options.limit);
      }
      callback(null, list, slug, newestFirstIds.length);
    });
  }

  function run(options) {
    return new Promise(function (resolve, reject) {
      fetchTaggedEntries("blog-1", "foo", options, function (err, result) {
        if (err) return reject(err);
        resolve(result);
      });
    });
  }

  it("keeps newest-first order for the default selection", async function () {
    stubTag(NEWEST_FIRST);
    const result = await run({ limit: 10, offset: 0 });
    expect(result.entryIDs).toEqual(NEWEST_FIRST);
  });

  it("paginates date + desc in Redis (oldest-first, no full-list fetch)", async function () {
    stubTag(NEWEST_FIRST);
    const result = await run({ limit: 10, offset: 0, sortBy: "date", order: "desc" });

    expect(result.entryIDs).toEqual(["a.txt", "b.txt", "c.txt", "d.txt"]);
    // Redis-side pagination: a page-sized request with rev:false, not zRange 0 -1.
    expect(lastTagOptions.rev).toBe(false);
    expect(lastTagOptions.limit).toBe(10);
  });

  it("sorts by file path A to Z for id + asc", async function () {
    stubTag(NEWEST_FIRST);
    const result = await run({ limit: 10, offset: 0, sortBy: "id", order: "asc" });

    expect(result.entryIDs).toEqual(["a.txt", "b.txt", "c.txt", "d.txt"]);
    // "id" sorting has no index, so the whole list is pulled (no limit).
    expect(lastTagOptions.limit).toBeUndefined();
  });

  it("sorts by file path Z to A for id + desc", async function () {
    stubTag(NEWEST_FIRST);
    const result = await run({ limit: 10, offset: 0, sortBy: "id", order: "desc" });
    expect(result.entryIDs).toEqual(["d.txt", "c.txt", "b.txt", "a.txt"]);
  });

  it("orders the full list before paginating for an id selection", async function () {
    stubTag(NEWEST_FIRST);
    // Page 2, one per page, sorted by file path A to Z -> second entry is b.txt.
    const result = await run({ limit: 1, offset: 1, sortBy: "id", order: "asc" });
    expect(result.entryIDs).toEqual(["b.txt"]);
  });
});
