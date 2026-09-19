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
        expect(Entries.getAll).toHaveBeenCalledTimes(1);
        done();
      });
    });
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
