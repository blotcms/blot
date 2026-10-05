describe("archives", function () {
  require("blog/tests/util/setup")();

  it("groups entries by year and month", async function () {
    await this.write({
      path: "/a.txt",
      content: "Title: A\nDate: 2020-01-02\n\nA body",
    });
    await this.write({
      path: "/b.txt",
      content: "Title: B\nDate: 2021-03-04\n\nB body",
    });

    await this.template(
      {
        "arch.html": `{{#archives}}{{year}}:{{#months}}{{month}}({{#entries}}{{title}} {{/entries}}){{/months}} {{/archives}}`,
      },
      { views: { "arch.html": { url: "/arch" } } }
    );

    const text = (await (await this.get("/arch")).text()).trim();
    expect(text).toContain("2021:March(B )");
    expect(text).toContain("2020:January(A )");
  });

  it("keeps html for a view that needs it after a view that doesn't, and drops it again after", async function () {
    await this.write({
      path: "/a.txt",
      content: "Title: A\nDate: 2020-01-02\n\nA body",
    });

    await this.template(
      {
        "list.html": `{{#archives}}{{#months}}{{#entries}}{{title}} {{/entries}}{{/months}}{{/archives}}`,
        "full.html": `{{#archives}}{{#months}}{{#entries}}{{{html}}}{{/entries}}{{/months}}{{/archives}}`,
      },
      {
        views: {
          "list.html": { url: "/list" },
          "full.html": { url: "/full" },
        },
      }
    );

    const before = await (await this.get("/list?json=1")).json();
    expect(before.archives[0].months[0].entries[0].html).toBeUndefined();

    const rendered = await (await this.get("/full")).text();
    expect(rendered).toContain("A body");

    const after = await (await this.get("/list?json=1")).json();
    const entry = after.archives[0].months[0].entries[0];
    expect(entry.title).toEqual("A");
    expect(entry.html).toBeUndefined();
  });

  it("drops unreferenced heavy fields from archives entries", async function () {
    await this.write({
      path: "/a.txt",
      content: "Title: A\nDate: 2020-01-02\n\nA body",
    });

    await this.template(
      {
        "arch.html": `{{#archives}}{{#months}}{{#entries}}{{title}}{{/entries}}{{/months}}{{/archives}}`,
      },
      { views: { "arch.html": { url: "/arch" } } }
    );

    const locals = await (await this.get("/arch?json=1")).json();
    const entry = locals.archives[0].months[0].entries[0];

    expect(entry.title).toEqual("A");
    expect(entry.html).toBeUndefined();
    expect(entry.summary).toBeUndefined();
  });
});

describe("archives cache", function () {
  const Entries = require("models/entries");
  const archivesPath = require.resolve("../archives");
  const allEntriesPath = require.resolve("../all_entries");
  const getAllCachedPath = require.resolve("../helpers/getAllCached");

  function loadArchives() {
    delete require.cache[archivesPath];
    delete require.cache[allEntriesPath];
    delete require.cache[getAllCachedPath];
    const archives = require("../archives");
    const getAllCached = require("../helpers/getAllCached");
    return { archives, getAllCached };
  }

  afterEach(function () {
    delete require.cache[archivesPath];
    delete require.cache[allEntriesPath];
    delete require.cache[getAllCachedPath];
  });

  function makeReq(blog, retrieve) {
    return {
      blog,
      retrieve: retrieve || {},
      log: function () {},
    };
  }

  it("reuses the cached grouping for identical cacheIDs", function (done) {
    const { archives } = loadArchives();

    spyOn(Entries, "getAll").and.callFake(function (blogID, options, callback) {
      callback([{ id: "1", title: "A", dateStamp: Date.parse("2020-01-02") }]);
    });

    const req = makeReq({ id: "blog-1", cacheID: 100, timeZone: "UTC" });

    archives(req, { locals: {} }, function () {
      archives(req, { locals: {} }, function () {
        expect(Entries.getAll).toHaveBeenCalledTimes(1);
        done();
      });
    });
  });

  it("yields to the event loop between the passes of a cold fill, but not on a hit", function (done) {
    const { archives } = loadArchives();

    spyOn(Entries, "getAll").and.callFake(function (blogID, options, callback) {
      callback([{ id: "1", title: "A", dateStamp: Date.parse("2020-01-02") }]);
    });
    const yields = spyOn(global, "setImmediate").and.callThrough();

    const req = makeReq({ id: "blog-yield", cacheID: 100, timeZone: "UTC" });

    archives(req, { locals: {} }, function () {
      // catalog clone, then before augmenting, then before sizing the result
      expect(yields.calls.count()).toBeGreaterThanOrEqual(3);
      yields.calls.reset();

      archives(req, { locals: {} }, function () {
        expect(yields).not.toHaveBeenCalled();
        done();
      });
    });
  });

  it("refetches when cacheID changes", function (done) {
    const { archives } = loadArchives();

    spyOn(Entries, "getAll").and.callFake(function (blogID, options, callback) {
      callback([{ id: "1", title: "A", dateStamp: Date.parse("2020-01-02") }]);
    });

    archives(
      makeReq({ id: "blog-1", cacheID: 100, timeZone: "UTC" }),
      { locals: {} },
      function () {
        archives(
          makeReq({ id: "blog-1", cacheID: 101, timeZone: "UTC" }),
          { locals: {} },
          function () {
            expect(Entries.getAll).toHaveBeenCalledTimes(2);
            done();
          }
        );
      }
    );
  });

  it("returns isolated copies so caller mutations do not taint cache", function (done) {
    const { archives } = loadArchives();

    spyOn(Entries, "getAll").and.callFake(function (blogID, options, callback) {
      callback([{ id: "1", title: "Original", dateStamp: Date.parse("2020-01-02") }]);
    });

    const req = makeReq({ id: "blog-1", cacheID: 100, timeZone: "UTC" });

    archives(req, { locals: {} }, function (err, firstYears) {
      firstYears[0].months[0].entries[0].title = "Mutated";

      archives(req, { locals: {} }, function (err, secondYears) {
        expect(secondYears[0].months[0].entries[0].title).toBe("Original");
        done();
      });
    });
  });

  it("shares one getAll fetch with all_entries for the same request", function (done) {
    const { archives, getAllCached } = loadArchives();
    const allEntries = require("../all_entries");

    spyOn(Entries, "getAll").and.callFake(function (blogID, options, callback) {
      callback([{ id: "1", title: "A", dateStamp: Date.parse("2020-01-02") }]);
    });

    const req = makeReq({ id: "blog-1", cacheID: 100, timeZone: "UTC" });

    archives(req, { locals: {} }, function () {
      allEntries(req, { locals: {} }, function () {
        expect(Entries.getAll).toHaveBeenCalledTimes(1);
        done();
      });
    });
  });

  it("stores separate entries per referenced field set so a stripped cache entry can't leak into a view that needs more", function (done) {
    const { archives } = loadArchives();

    spyOn(Entries, "getAll").and.callFake(function (blogID, options, callback) {
      callback([
        {
          id: "1",
          title: "A",
          html: "<p>A body</p>",
          dateStamp: Date.parse("2020-01-02"),
        },
      ]);
    });

    const blog = { id: "blog-1", cacheID: 100, timeZone: "UTC" };

    const titleOnlyReq = makeReq(blog, {
      archives: { fields: { title: true } },
    });
    const withHtmlReq = makeReq(blog, {
      archives: { fields: { title: true, html: true } },
    });

    archives(titleOnlyReq, { locals: {} }, function (err, years) {
      expect(years[0].months[0].entries[0].html).toBeUndefined();

      archives(withHtmlReq, { locals: {} }, function (err, years2) {
        expect(years2[0].months[0].entries[0].html).toBe("<p>A body</p>");
        // The title-only fill never held html, so this view can't be served
        // from it and has to refetch.
        expect(Entries.getAll).toHaveBeenCalledTimes(2);
        done();
      });
    });
  });

  it("serves a title-only view from a catalog cached with html, without leaking html", function (done) {
    const { archives } = loadArchives();

    spyOn(Entries, "getAll").and.callFake(function (blogID, options, callback) {
      callback([
        {
          id: "1",
          title: "A",
          html: "<p>A body</p>",
          dateStamp: Date.parse("2020-01-02"),
        },
      ]);
    });

    const blog = { id: "blog-1", cacheID: 100, timeZone: "UTC" };

    const titleOnlyReq = makeReq(blog, {
      archives: { fields: { title: true } },
    });
    const withHtmlReq = makeReq(blog, {
      archives: { fields: { title: true, html: true } },
    });

    archives(withHtmlReq, { locals: {} }, function (err, years) {
      expect(years[0].months[0].entries[0].html).toBe("<p>A body</p>");

      archives(titleOnlyReq, { locals: {} }, function (err, years2) {
        expect(years2[0].months[0].entries[0].title).toBe("A");
        expect(years2[0].months[0].entries[0].html).toBeUndefined();
        expect(Entries.getAll).toHaveBeenCalledTimes(1);
        done();
      });
    });
  });

  it("shares one getAll fetch between allEntries and archives that reference different fields", async function () {
    const { archives } = loadArchives();
    const allEntries = require("../all_entries");

    spyOn(Entries, "getAll").and.callFake(function (blogID, options, callback) {
      callback([
        {
          id: "1",
          title: "A",
          html: "<p>A body</p>",
          summary: "A summary",
          dateStamp: Date.parse("2020-01-02"),
        },
      ]);
    });

    // The catalog is kept with the union of both locals' heavy fields, so
    // one fill serves both, each projecting down to its own.
    const req = makeReq(
      { id: "blog-1", cacheID: 100, timeZone: "UTC" },
      {
        allEntries: { fields: { title: true } },
        archives: { fields: { title: true, html: true } },
      }
    );

    const years = await archives(req, { locals: {} });
    const list = await allEntries(req, { locals: {} });

    expect(Entries.getAll).toHaveBeenCalledTimes(1);
    expect(years[0].months[0].entries[0].html).toBe("<p>A body</p>");
    expect(years[0].months[0].entries[0].summary).toBeUndefined();
    expect(list[0].title).toBe("A");
    expect(list[0].html).toBeUndefined();
    expect(list[0].summary).toBeUndefined();
  });

  it("bypasses the cache for preview requests", function (done) {
    const { archives } = loadArchives();

    spyOn(Entries, "getAll").and.callFake(function (blogID, options, callback) {
      callback([{ id: "1", title: "A", dateStamp: Date.parse("2020-01-02") }]);
    });

    const req = makeReq({ id: "blog-1", cacheID: 100, timeZone: "UTC" });
    req.preview = true;

    archives(req, { locals: {} }, function () {
      archives(req, { locals: {} }, function () {
        expect(Entries.getAll).toHaveBeenCalledTimes(2);
        done();
      });
    });
  });

  it("does not cache an empty result, so a transient Redis failure isn't mistaken for an empty blog", function (done) {
    const { archives } = loadArchives();

    // Entries.getAll resolves to [] on a failed zRange/mGet rather than
    // rejecting (see models/entries/index.js getRange's .catch), so an
    // empty array from it is ambiguous between "no posts" and "Redis
    // hiccup." Caching it either way risks hiding every post until the
    // cacheID changes; refetching on every miss is the safe default.
    spyOn(Entries, "getAll").and.callFake(function (blogID, options, callback) {
      callback([]);
    });

    const req = makeReq({ id: "blog-1", cacheID: 100, timeZone: "UTC" });

    archives(req, { locals: {} }, function () {
      archives(req, { locals: {} }, function () {
        expect(Entries.getAll).toHaveBeenCalledTimes(2);
        done();
      });
    });
  });
});

describe("archives shared augmentation", function () {
  const Entries = require("models/entries");
  const Entry = require("models/entry/instance");
  const archivesPath = require.resolve("../archives");
  const getAllCachedPath = require.resolve("../helpers/getAllCached");

  afterEach(function () {
    delete require.cache[archivesPath];
    delete require.cache[getAllCachedPath];
  });

  function makeReq(blogURL) {
    return {
      blog: {
        id: "blog-1",
        cacheID: 100,
        timeZone: "UTC",
        locals: { blogURL },
      },
      retrieve: {},
      log: function () {},
    };
  }

  it("shares augmented entries across hits with a per-request absoluteURL", async function () {
    delete require.cache[archivesPath];
    delete require.cache[getAllCachedPath];
    const archives = require("../archives");

    spyOn(Entries, "getAll").and.callFake(function (blogID, options, callback) {
      callback([
        new Entry({
          id: "/a.txt",
          path: "/a.txt",
          url: "/a",
          title: "A",
          tags: ["Foo"],
          dateStamp: Date.UTC(2020, 0, 2),
          backlinks: [],
        }),
      ]);
    });

    const first = await archives(makeReq("https://example.com"), {
      locals: {},
    });
    const second = await archives(makeReq("http://www.example.com"), {
      locals: {},
    });

    const a = first[0].months[0].entries[0];
    const b = second[0].months[0].entries[0];

    expect(a.__augmented).toBe(true);
    expect(b).not.toBe(a);
    expect(b.tags).toBe(a.tags);
    expect(a.absoluteURL).toBe("https://example.com/a");
    expect(b.absoluteURL).toBe("http://www.example.com/a");
    expect(second[0].months).not.toBe(first[0].months);
    expect(Entries.getAll).toHaveBeenCalledTimes(1);
  });
});
