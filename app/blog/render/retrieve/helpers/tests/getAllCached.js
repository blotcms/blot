describe("getAllCached", function () {
  const Entries = require("models/entries");
  const Entry = require("models/entry/instance");
  const getAllCachedPath = require.resolve("../getAllCached");

  const ALL_HEAVY = ["html", "body", "teaser", "teaserBody", "summary"];
  const blog = { id: "blog-1", cacheID: 100 };

  let getAllCached;

  beforeEach(function () {
    delete require.cache[getAllCachedPath];
    getAllCached = require("../getAllCached");
  });

  afterEach(function () {
    delete require.cache[getAllCachedPath];
  });

  // A fresh catalog on every call, since getAllCached strips it in place.
  function catalog() {
    return [
      {
        id: "/a.txt",
        path: "/a.txt",
        url: "/a",
        title: "A",
        dateStamp: 1577923200000,
        tags: ["foo"],
        thumbnail: { small: { url: "/t.jpg" } },
        metadata: { color: "red" },
        backlinks: [],
        html: "<p>A body</p>",
        body: "A body",
        teaser: "<p>A</p>",
        teaserBody: "A",
        summary: "A summary",
      },
      {
        id: "/b.txt",
        path: "/b.txt",
        url: "/b",
        title: "B",
        dateStamp: 1577836800000,
        tags: [],
        thumbnail: {},
        metadata: {},
        backlinks: [],
        html: "<p>B body</p>",
        body: "B body",
        teaser: "<p>B</p>",
        teaserBody: "B",
        summary: "B summary",
      },
    ];
  }

  function stubCatalog() {
    spyOn(Entries, "getAll").and.callFake(function (blogID, options, callback) {
      callback(catalog());
    });
  }

  // Entries.getAll calls that wait until the test resolves them, in the order
  // they were made.
  function deferGetAll() {
    const pending = [];
    spyOn(Entries, "getAll").and.callFake(function (blogID, options, callback) {
      pending.push(() => callback(catalog()));
    });
    return pending;
  }

  function retrieveWith(fields) {
    return { allEntries: { fields } };
  }

  const NARROW = retrieveWith({ title: true });
  const WIDE = retrieveWith({ title: true, html: true });

  describe("_heavyFieldsToKeep", function () {
    it("keeps every heavy field without retrieve metadata or when no catalog local is referenced", function () {
      expect(getAllCached._heavyFieldsToKeep(undefined)).toEqual(ALL_HEAVY);
      expect(getAllCached._heavyFieldsToKeep({})).toEqual(ALL_HEAVY);
    });

    it("keeps no heavy field when the locals only reference light fields", function () {
      expect(
        getAllCached._heavyFieldsToKeep(retrieveWith({ title: true, url: true }))
      ).toEqual([]);
    });

    it("keeps the heavy fields a local references", function () {
      expect(
        getAllCached._heavyFieldsToKeep(retrieveWith({ title: true, html: true }))
      ).toEqual(["html"]);
    });

    it("counts the all_entries alias", function () {
      expect(
        getAllCached._heavyFieldsToKeep({
          all_entries: { fields: { title: true, body: true } },
        })
      ).toEqual(["body"]);
    });

    it("unions the heavy fields of allEntries and archives, in HEAVY_FIELDS order", function () {
      const keep = getAllCached._heavyFieldsToKeep({
        allEntries: { fields: { summary: true } },
        archives: { fields: { html: true } },
      });

      expect(keep).toEqual(["html", "summary"]);
    });

    it("keeps every heavy field when a referenced local has no fields map", function () {
      [{}, true, { length: true }].forEach(function (value) {
        expect(getAllCached._heavyFieldsToKeep({ allEntries: value })).toEqual(
          ALL_HEAVY
        );
        expect(getAllCached._heavyFieldsToKeep({ archives: value })).toEqual(
          ALL_HEAVY
        );
        expect(
          getAllCached._heavyFieldsToKeep({
            allEntries: value,
            archives: { fields: { title: true } },
          })
        ).toEqual(ALL_HEAVY);
        expect(
          getAllCached._heavyFieldsToKeep({
            allEntries: { fields: { title: true } },
            archives: value,
          })
        ).toEqual(ALL_HEAVY);
      });
    });

    it("keeps every heavy field when only unrelated locals are referenced", function () {
      expect(
        getAllCached._heavyFieldsToKeep({ posts: { fields: { html: true } } })
      ).toEqual(ALL_HEAVY);
    });

    it("ignores unrelated locals when a catalog local is referenced", function () {
      expect(
        getAllCached._heavyFieldsToKeep({
          posts: { fields: { html: true } },
          allEntries: { fields: { title: true } },
        })
      ).toEqual([]);
    });
  });

  it("strips the heavy fields no local references and keeps the rest", async function () {
    stubCatalog();

    const entries = await getAllCached(blog, {
      retrieve: retrieveWith({ title: true, summary: true }),
    });

    expect(entries.length).toEqual(2);
    expect(entries[0].summary).toEqual("A summary");
    ["html", "body", "teaser", "teaserBody"].forEach(function (field) {
      expect(entries[0][field]).toBeUndefined();
      expect(field in entries[0]).toBe(false);
      expect(entries[1][field]).toBeUndefined();
    });
  });

  it("keeps every light field when stripping heavy ones", async function () {
    stubCatalog();

    const entries = await getAllCached(blog, { retrieve: NARROW });
    const expected = catalog()[0];

    ["id", "path", "url", "title", "dateStamp", "tags", "thumbnail", "metadata", "backlinks"].forEach(
      function (field) {
        expect(entries[0][field]).toEqual(expected[field]);
      }
    );
  });

  it("returns complete entries when no retrieve option is passed", async function () {
    stubCatalog();

    const entries = await getAllCached(blog);

    expect(entries).toEqual(catalog());
  });

  it("fetches once for repeat calls with the same needs", async function () {
    stubCatalog();

    const first = await getAllCached(blog, { retrieve: WIDE });
    const second = await getAllCached(blog, { retrieve: WIDE });

    expect(Entries.getAll).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("refetches when a narrow fill is followed by a request that needs more", async function () {
    stubCatalog();

    const narrow = await getAllCached(blog, { retrieve: NARROW });
    const wide = await getAllCached(blog, { retrieve: WIDE });

    expect(narrow[0].html).toBeUndefined();
    expect(Entries.getAll).toHaveBeenCalledTimes(2);
    expect(wide[0].html).toEqual("<p>A body</p>");
    expect(wide[0].body).toBeUndefined();
  });

  it("serves a narrow request from a wide fill without mutating the cached copy", async function () {
    stubCatalog();

    await getAllCached(blog, { retrieve: WIDE });
    const narrow = await getAllCached(blog, { retrieve: NARROW });
    const wideAgain = await getAllCached(blog, { retrieve: WIDE });

    expect(Entries.getAll).toHaveBeenCalledTimes(1);
    expect(narrow[0].html).toBeUndefined();
    expect(narrow[0].title).toEqual("A");
    expect(wideAgain[0].html).toEqual("<p>A body</p>");
    expect(wideAgain[1].html).toEqual("<p>B body</p>");
  });

  it("serves a request from a copy that kept more than the one it needs", async function () {
    stubCatalog();

    await getAllCached(blog); // all five heavy fields
    const entries = await getAllCached(blog, {
      retrieve: retrieveWith({ title: true, summary: true }),
    });

    expect(Entries.getAll).toHaveBeenCalledTimes(1);
    expect(entries[0].summary).toEqual("A summary");
    expect(entries[0].html).toBeUndefined();
    expect(entries[0].body).toBeUndefined();
  });

  it("evicts the narrower copy when a wider one is stored", async function () {
    stubCatalog();

    await getAllCached(blog, { retrieve: NARROW });
    expect(getAllCached._stats().size).toEqual(1);

    await getAllCached(blog, { retrieve: WIDE });
    expect(Entries.getAll).toHaveBeenCalledTimes(2);
    expect(getAllCached._stats().size).toEqual(1);

    // The wide copy now serves the narrow request, so no third fetch.
    const narrow = await getAllCached(blog, { retrieve: NARROW });
    expect(narrow[0].html).toBeUndefined();
    expect(Entries.getAll).toHaveBeenCalledTimes(2);
    expect(getAllCached._stats().size).toEqual(1);
  });

  it("does not evict a copy that kept fields the new one did not", async function () {
    stubCatalog();

    await getAllCached(blog, { retrieve: retrieveWith({ html: true }) });
    await getAllCached(blog, { retrieve: retrieveWith({ summary: true }) });

    expect(Entries.getAll).toHaveBeenCalledTimes(2);
    expect(getAllCached._stats().size).toEqual(2);
  });

  describe("concurrent requests", function () {
    it("shares a wide in-flight fill with a narrow request that starts after it", async function () {
      const pending = deferGetAll();

      const wide = getAllCached(blog, { retrieve: WIDE });
      const narrow = getAllCached(blog, { retrieve: NARROW });

      expect(Entries.getAll).toHaveBeenCalledTimes(1);
      pending[0]();

      const [wideEntries, narrowEntries] = await Promise.all([wide, narrow]);

      expect(Entries.getAll).toHaveBeenCalledTimes(1);
      expect(wideEntries[0].html).toEqual("<p>A body</p>");
      expect(narrowEntries[0].html).toBeUndefined();
      expect(narrowEntries[0].title).toEqual("A");
    });

    it("fetches again for a wide request that starts while a narrow fill is in flight", async function () {
      const pending = deferGetAll();

      const narrow = getAllCached(blog, { retrieve: NARROW });
      const wide = getAllCached(blog, { retrieve: WIDE });

      expect(Entries.getAll).toHaveBeenCalledTimes(2);
      pending.forEach((resolve) => resolve());

      const [narrowEntries, wideEntries] = await Promise.all([narrow, wide]);

      expect(narrowEntries[0].html).toBeUndefined();
      expect(wideEntries[0].html).toEqual("<p>A body</p>");
    });

    it("does not store a narrow fill that resolves after a wider copy was stored", async function () {
      const pending = deferGetAll();

      const narrow = getAllCached(blog, { retrieve: NARROW });
      const wide = getAllCached(blog, { retrieve: WIDE });

      pending[1]();
      await wide;
      pending[0]();
      const narrowEntries = await narrow;

      expect(narrowEntries[0].html).toBeUndefined();
      expect(getAllCached._stats().size).toEqual(1);

      // The wide copy serves the narrow request.
      await getAllCached(blog, { retrieve: NARROW });
      expect(Entries.getAll).toHaveBeenCalledTimes(2);
      expect(getAllCached._stats().size).toEqual(1);
    });

    it("shares one in-flight fill between requests with the same needs", async function () {
      const pending = deferGetAll();

      const first = getAllCached(blog, { retrieve: WIDE });
      const second = getAllCached(blog, { retrieve: WIDE });

      expect(Entries.getAll).toHaveBeenCalledTimes(1);
      pending[0]();
      await Promise.all([first, second]);

      expect(Entries.getAll).toHaveBeenCalledTimes(1);
    });
  });

  it("returns isolated copies so caller mutations do not taint the cache", async function () {
    stubCatalog();

    const first = await getAllCached(blog, { retrieve: WIDE });
    first[0].title = "Mutated";
    first[0].extra = "added";
    delete first[0].html;
    first.pop();

    const second = await getAllCached(blog, { retrieve: WIDE });

    expect(second.length).toEqual(2);
    expect(second[0].title).toEqual("A");
    expect(second[0].extra).toBeUndefined();
    expect(second[0].html).toEqual("<p>A body</p>");
  });

  it("returns isolated copies when a narrow request is served from a wider one", async function () {
    stubCatalog();

    await getAllCached(blog, { retrieve: WIDE });
    const narrow = await getAllCached(blog, { retrieve: NARROW });
    narrow[0].title = "Mutated";
    narrow[0].tags.push("added");

    const again = await getAllCached(blog, { retrieve: NARROW });

    expect(again[0].title).toEqual("A");
    expect(again[0].tags).toEqual(["foo"]);
  });

  it("refetches when cacheID changes", async function () {
    stubCatalog();

    await getAllCached({ id: "blog-1", cacheID: 100 }, { retrieve: NARROW });
    await getAllCached({ id: "blog-1", cacheID: 101 }, { retrieve: NARROW });

    expect(Entries.getAll).toHaveBeenCalledTimes(2);
  });

  it("does not share entries between blogs", async function () {
    stubCatalog();

    await getAllCached({ id: "blog-1", cacheID: 100 }, { retrieve: WIDE });
    await getAllCached({ id: "blog-2", cacheID: 100 }, { retrieve: NARROW });

    expect(Entries.getAll).toHaveBeenCalledTimes(2);
    expect(Entries.getAll.calls.argsFor(0)[0]).toEqual("blog-1");
    expect(Entries.getAll.calls.argsFor(1)[0]).toEqual("blog-2");
  });

  describe("bypassCache", function () {
    it("neither reads nor writes the cache", async function () {
      stubCatalog();

      await getAllCached(blog, { bypassCache: true, retrieve: WIDE });
      expect(getAllCached._stats().size).toEqual(0);

      await getAllCached(blog, { retrieve: WIDE });
      expect(Entries.getAll).toHaveBeenCalledTimes(2);
      expect(getAllCached._stats().size).toEqual(1);

      // A populated cache is not read either.
      await getAllCached(blog, { bypassCache: true, retrieve: WIDE });
      expect(Entries.getAll).toHaveBeenCalledTimes(3);
    });

    it("still strips heavy fields per retrieve", async function () {
      stubCatalog();

      const entries = await getAllCached(blog, {
        bypassCache: true,
        retrieve: NARROW,
      });

      expect(entries[0].title).toEqual("A");
      ALL_HEAVY.forEach(function (field) {
        expect(entries[0][field]).toBeUndefined();
      });
    });

    it("still shares one in-flight fetch between concurrent requests", async function () {
      const pending = deferGetAll();

      const first = getAllCached(blog, { bypassCache: true, retrieve: WIDE });
      const second = getAllCached(blog, { bypassCache: true, retrieve: WIDE });

      expect(Entries.getAll).toHaveBeenCalledTimes(1);
      pending[0]();
      await Promise.all([first, second]);

      expect(Entries.getAll).toHaveBeenCalledTimes(1);
    });
  });

  it("does not cache an empty catalog", async function () {
    spyOn(Entries, "getAll").and.callFake(function (blogID, options, callback) {
      callback([]);
    });

    await getAllCached(blog, { retrieve: NARROW });
    await getAllCached(blog, { retrieve: NARROW });

    expect(Entries.getAll).toHaveBeenCalledTimes(2);
    expect(getAllCached._stats().size).toEqual(0);
  });

  it("returns Entry instances when getAll returns them, whether or not heavy fields are stripped", async function () {
    spyOn(Entries, "getAll").and.callFake(function (blogID, options, callback) {
      callback(catalog().map((entry) => new Entry(entry)));
    });

    const wide = await getAllCached(blog, { retrieve: WIDE });
    const narrowFromWide = await getAllCached(blog, { retrieve: NARROW });
    const full = await getAllCached(blog);

    [wide, narrowFromWide, full].forEach(function (entries) {
      entries.forEach(function (entry) {
        expect(entry instanceof Entry).toBe(true);
      });
    });

    const other = { id: "blog-2", cacheID: 100 };
    const narrowFill = await getAllCached(other, { retrieve: NARROW });
    expect(narrowFill[0] instanceof Entry).toBe(true);
    expect(narrowFill[0].html).toBeUndefined();
  });
});
