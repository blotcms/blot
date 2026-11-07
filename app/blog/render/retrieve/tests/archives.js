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

  it("keeps html for a view that only renders it from a nested partial, after a view that doesn't", async function () {
    await this.write({
      path: "/a.txt",
      content: "Title: A\nDate: 2020-01-02\n\nA body",
    });

    await this.template(
      {
        "list.html": `{{#archives}}{{#months}}{{#entries}}{{title}} {{/entries}}{{/months}}{{/archives}}`,
        "full.html": `{{#archives}}{{#months}}{{#entries}}{{> row.html}}{{/entries}}{{/months}}{{/archives}}`,
        "row.html": `<div>{{> content.html}}</div>`,
        "content.html": `{{{html}}}`,
      },
      {
        views: {
          "list.html": { url: "/list" },
          "full.html": { url: "/full" },
        },
      }
    );

    // Fills the catalog cache without html first.
    const before = await (await this.get("/list?json=1")).json();
    expect(before.archives[0].months[0].entries[0].html).toBeUndefined();

    const full = await (await this.get("/full?json=1")).json();
    expect(full.archives[0].months[0].entries[0].html).toContain("A body");

    const rendered = await (await this.get("/full")).text();
    expect(rendered).toMatch(/<div>[^]*A body[^]*<\/div>/);
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
    require("models/entries/catalog")._clear();
    const archives = require("../archives");
    const getAllCached = require("../helpers/getAllCached");
    return { archives, getAllCached };
  }

  afterEach(function () {
    delete require.cache[archivesPath];
    delete require.cache[allEntriesPath];
    delete require.cache[getAllCachedPath];
    require("models/entries/catalog")._clear();
  });

  function makeReq(blog, retrieve) {
    return {
      blog,
      retrieve: retrieve || {},
      log: function () {},
    };
  }

  it("reuses the cached grouping for identical cacheIDs", async function () {
    const { archives } = loadArchives();

    spyOn(Entries, "getAll").and.callFake(function (blogID, options) {
      return Promise.resolve([
        { id: "1", title: "A", dateStamp: Date.parse("2020-01-02") },
      ]);
    });

    const req = makeReq({ id: "blog-1", cacheID: 100, timeZone: "UTC" });

    await archives(req, { locals: {} });
    await archives(req, { locals: {} });
    expect(Entries.getAll).toHaveBeenCalledTimes(1);
  });

  it("yields to the event loop between the passes of a cold fill, but not on a hit", async function () {
    const { archives } = loadArchives();

    spyOn(Entries, "getAll").and.callFake(function (blogID, options) {
      return Promise.resolve([
        { id: "1", title: "A", dateStamp: Date.parse("2020-01-02") },
      ]);
    });
    const yields = spyOn(global, "setImmediate").and.callThrough();

    const req = makeReq({ id: "blog-yield", cacheID: 100, timeZone: "UTC" });

    await archives(req, { locals: {} });
    // catalog clone, then before augmenting, then before sizing the result
    expect(yields.calls.count()).toBeGreaterThanOrEqual(3);
    yields.calls.reset();

    await archives(req, { locals: {} });
    expect(yields).not.toHaveBeenCalled();
  });

  it("refetches when cacheID changes", async function () {
    const { archives } = loadArchives();

    spyOn(Entries, "getAll").and.callFake(function (blogID, options) {
      return Promise.resolve([
        { id: "1", title: "A", dateStamp: Date.parse("2020-01-02") },
      ]);
    });

    await archives(makeReq({ id: "blog-1", cacheID: 100, timeZone: "UTC" }), {
      locals: {},
    });
    await archives(makeReq({ id: "blog-1", cacheID: 101, timeZone: "UTC" }), {
      locals: {},
    });
    expect(Entries.getAll).toHaveBeenCalledTimes(2);
  });

  it("returns isolated copies so caller mutations do not taint cache", async function () {
    const { archives } = loadArchives();

    spyOn(Entries, "getAll").and.callFake(function (blogID, options) {
      return Promise.resolve([
        { id: "1", title: "Original", dateStamp: Date.parse("2020-01-02") },
      ]);
    });

    const req = makeReq({ id: "blog-1", cacheID: 100, timeZone: "UTC" });

    const firstYears = await archives(req, { locals: {} });
    firstYears[0].months[0].entries[0].title = "Mutated";

    const secondYears = await archives(req, { locals: {} });
    expect(secondYears[0].months[0].entries[0].title).toBe("Original");
  });

  it("shares one getAll fetch with all_entries for the same request", async function () {
    const { archives } = loadArchives();
    const allEntries = require("../all_entries");

    spyOn(Entries, "getAll").and.callFake(function (blogID, options) {
      return Promise.resolve([
        { id: "1", title: "A", dateStamp: Date.parse("2020-01-02") },
      ]);
    });

    const req = makeReq({ id: "blog-1", cacheID: 100, timeZone: "UTC" });

    await archives(req, { locals: {} });
    await allEntries(req, { locals: {} });
    expect(Entries.getAll).toHaveBeenCalledTimes(1);
  });

  it("stores separate entries per referenced field set so a stripped cache entry can't leak into a view that needs more", async function () {
    const { archives } = loadArchives();

    spyOn(Entries, "getAll").and.callFake(function (blogID, options) {
      return Promise.resolve([
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

    const years = await archives(titleOnlyReq, { locals: {} });
    expect(years[0].months[0].entries[0].html).toBeUndefined();

    const years2 = await archives(withHtmlReq, { locals: {} });
    expect(years2[0].months[0].entries[0].html).toBe("<p>A body</p>");
    // The title-only fill never held html, so this view can't be served
    // from it and has to refetch.
    expect(Entries.getAll).toHaveBeenCalledTimes(2);
  });

  it("serves a title-only view from a catalog cached with html, without leaking html", async function () {
    const { archives } = loadArchives();

    spyOn(Entries, "getAll").and.callFake(function (blogID, options) {
      return Promise.resolve([
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

    const years = await archives(withHtmlReq, { locals: {} });
    expect(years[0].months[0].entries[0].html).toBe("<p>A body</p>");

    const years2 = await archives(titleOnlyReq, { locals: {} });
    expect(years2[0].months[0].entries[0].title).toBe("A");
    expect(years2[0].months[0].entries[0].html).toBeUndefined();
    expect(Entries.getAll).toHaveBeenCalledTimes(1);
  });

  it("shares one getAll fetch between all_entries and archives that reference different fields", async function () {
    const { archives } = loadArchives();
    const allEntries = require("../all_entries");

    spyOn(Entries, "getAll").and.callFake(function (blogID, options) {
      return Promise.resolve([
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
        all_entries: { fields: { title: true } },
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

  it("shares the catalog, but not its own cache, with preview requests", async function () {
    const { archives } = loadArchives();

    spyOn(Entries, "getAll").and.callFake(function (blogID, options) {
      return Promise.resolve([
        { id: "1", title: "A", dateStamp: Date.parse("2020-01-02") },
      ]);
    });

    const req = makeReq({ id: "blog-1", cacheID: 100, timeZone: "UTC" });
    req.preview = true;

    await archives(req, { locals: {} });
    await archives(req, { locals: {} });
    expect(Entries.getAll).toHaveBeenCalledTimes(1);
  });

  it("does not cache an empty result, so a transient Redis failure isn't mistaken for an empty blog", async function () {
    const { archives } = loadArchives();

    // Entries.getAll resolves to [] on a failed zRange/mGet rather than
    // rejecting (see models/entries/index.js getRange's .catch), so an
    // empty array from it is ambiguous between "no posts" and "Redis
    // hiccup." Caching it either way risks hiding every post until the
    // cacheID changes; refetching on every miss is the safe default.
    spyOn(Entries, "getAll").and.callFake(function (blogID, options) {
      return Promise.resolve([]);
    });

    const req = makeReq({ id: "blog-1", cacheID: 100, timeZone: "UTC" });

    await archives(req, { locals: {} });
    await archives(req, { locals: {} });
    expect(Entries.getAll).toHaveBeenCalledTimes(2);
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
    require("models/entries/catalog")._clear();
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
    require("models/entries/catalog")._clear();
    const archives = require("../archives");

    spyOn(Entries, "getAll").and.callFake(function (blogID, options) {
      return Promise.resolve([
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
