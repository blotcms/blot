describe("all_entries", function () {
  require("blog/tests/util/setup")();

  it("renders every entry", async function () {
    await this.write({ path: "/a.txt", content: "Title: A\n\nA body" });
    await this.write({ path: "/b.txt", content: "Title: B\n\nB body" });

    await this.template(
      { "list.html": `{{#all_entries}}{{title}} {{/all_entries}}` },
      { views: { "list.html": { url: "/list" } } }
    );

    const res = await this.get("/list");
    expect((await res.text()).trim().split(/\s+/).sort()).toEqual(["A", "B"]);
  });

  it("keeps html for a view that needs it after a view that doesn't, and drops it again after", async function () {
    await this.write({ path: "/a.txt", content: "Title: A\n\nA body" });

    await this.template(
      {
        "list.html": `{{#all_entries}}{{title}} {{/all_entries}}`,
        "full.html": `{{#all_entries}}{{{html}}}{{/all_entries}}`,
      },
      {
        views: {
          "list.html": { url: "/list" },
          "full.html": { url: "/full" },
        },
      }
    );

    const before = await (await this.get("/list?json=1")).json();
    expect(before.all_entries[0].html).toBeUndefined();

    const rendered = await (await this.get("/full")).text();
    expect(rendered).toContain("A body");

    const after = await (await this.get("/list?json=1")).json();
    expect(after.all_entries[0].title).toEqual("A");
    expect(after.all_entries[0].html).toBeUndefined();
  });

  it("keeps html for a view that only renders it from a nested partial, after a view that doesn't", async function () {
    await this.write({ path: "/a.txt", content: "Title: A\n\nA body" });

    await this.template(
      {
        "list.html": `{{#all_entries}}{{title}} {{/all_entries}}`,
        "full.html": `{{#all_entries}}{{> row.html}}{{/all_entries}}`,
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
    expect(before.all_entries[0].html).toBeUndefined();

    const full = await (await this.get("/full?json=1")).json();
    expect(full.all_entries[0].html).toContain("A body");

    const rendered = await (await this.get("/full")).text();
    expect(rendered).toMatch(/<div>[^]*A body[^]*<\/div>/);
  });

  it("drops unreferenced heavy fields from all_entries locals", async function () {
    await this.write({ path: "/a.txt", content: "Title: A\n\nA body" });

    await this.template(
      { "list.html": `{{#all_entries}}{{title}} {{url}}{{/all_entries}}` },
      { views: { "list.html": { url: "/list" } } }
    );

    const res = await this.get("/list?json=1");
    const locals = await res.json();

    expect(locals.all_entries.length).toEqual(1);
    expect(locals.all_entries[0].title).toEqual("A");
    expect(locals.all_entries[0].url).toBeDefined();
    expect(locals.all_entries[0].html).toBeUndefined();
    expect(locals.all_entries[0].body).toBeUndefined();
    expect(locals.all_entries[0].summary).toBeUndefined();
  });

  it("keeps entry html when the view renders it", async function () {
    await this.write({ path: "/a.txt", content: "Title: A\n\nA body" });

    await this.template(
      { "list.html": `{{#all_entries}}{{{html}}}{{/all_entries}}` },
      { views: { "list.html": { url: "/list" } } }
    );

    const res = await this.get("/list?json=1");
    const locals = await res.json();

    expect(locals.all_entries[0].html).toContain("A body");
  });

  it("keeps entry body when it is wrapped in an encoder helper", async function () {
    await this.write({ path: "/a.txt", content: "Title: A\n\nA body" });

    await this.template(
      {
        "list.html": `{{#all_entries}}{{#encode_xml}}{{{body}}}{{/encode_xml}}{{/all_entries}}`,
      },
      { views: { "list.html": { url: "/list" } } }
    );

    const res = await this.get("/list?json=1");
    const locals = await res.json();

    expect(locals.all_entries[0].body).toContain("A body");

    const rendered = await (await this.get("/list")).text();
    expect(rendered).toContain("A body");
  });

  it("does not treat a template-level string local as a nested template", async function () {
    await this.write({ path: "/a.txt", content: "Title: A\n\nA body" });

    await this.template(
      { "list.html": `{{#all_entries}}{{title}}{{/all_entries}}{{{snippet}}}` },
      {
        views: { "list.html": { url: "/list" } },
        locals: { snippet: "{{#all_entries}}{{{html}}} {{/all_entries}}" },
      }
    );

    const locals = await (await this.get("/list?json=1")).json();
    expect(locals.all_entries[0].html).toBeUndefined();

    const rendered = await (await this.get("/list")).text();
    expect(rendered).toContain("{{#all_entries}}{{{html}}} {{/all_entries}}");
    expect(rendered).not.toContain("A body");
  });

  it("does not treat a query string local as a nested template", async function () {
    await this.write({ path: "/a.txt", content: "Title: A\n\nA body" });

    await this.template(
      {
        "list.html": `{{#all_entries}}{{title}}{{/all_entries}}{{{query.snippet}}}`,
      },
      { views: { "list.html": { url: "/list" } } }
    );

    const snippet = encodeURIComponent(
      "{{#all_entries}}{{{html}}} {{/all_entries}}"
    );
    const locals = await (
      await this.get("/list?json=1&snippet=" + snippet)
    ).json();

    expect(locals.all_entries[0].html).toBeUndefined();
  });
});

describe("all_entries cache", function () {
  const Entries = require("models/entries");
  const allEntriesPath = require.resolve("../all_entries");
  const getAllCachedPath = require.resolve("../helpers/getAllCached");

  function loadAllEntries() {
    delete require.cache[allEntriesPath];
    delete require.cache[getAllCachedPath];
    require("models/entries/catalog")._clear();
    return require("../all_entries");
  }

  afterEach(function () {
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

  it("reuses cached entries for identical cacheIDs", function (done) {
    const allEntries = loadAllEntries();

    spyOn(Entries, "getAll").and.callFake(function (blogID, options) {
      return Promise.resolve([{ id: "1", title: "A" }]);
    });

    const req = makeReq({ id: "blog-1", cacheID: 100 });

    allEntries(req, { locals: {} }, function () {
      allEntries(req, { locals: {} }, function () {
        expect(Entries.getAll).toHaveBeenCalledTimes(1);
        done();
      });
    });
  });

  it("refetches when cacheID changes", function (done) {
    const allEntries = loadAllEntries();

    spyOn(Entries, "getAll").and.callFake(function (blogID, options) {
      return Promise.resolve([{ id: "1", title: "A" }]);
    });

    allEntries(
      makeReq({ id: "blog-1", cacheID: 100 }),
      { locals: {} },
      function () {
        allEntries(
          makeReq({ id: "blog-1", cacheID: 101 }),
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
    const allEntries = loadAllEntries();

    spyOn(Entries, "getAll").and.callFake(function (blogID, options) {
      return Promise.resolve([{ id: "1", title: "Original" }]);
    });

    const req = makeReq({ id: "blog-1", cacheID: 100 });

    allEntries(req, { locals: {} }, function (err, first) {
      first[0].title = "Mutated";

      allEntries(req, { locals: {} }, function (err, second) {
        expect(second[0].title).toBe("Original");
        done();
      });
    });
  });

  it("dedupes concurrent misses for the same cacheID into one getAll call", function (done) {
    const allEntries = loadAllEntries();

    let resolveGetAll;
    spyOn(Entries, "getAll").and.callFake(function (blogID, options) {
      return new Promise((resolve) => {
        resolveGetAll = () => resolve([{ id: "1", title: "A" }]);
      });
    });

    const req = makeReq({ id: "blog-1", cacheID: 100 });

    let doneCount = 0;
    function onDone() {
      doneCount++;
      if (doneCount === 2) {
        expect(Entries.getAll).toHaveBeenCalledTimes(1);
        done();
      }
    }

    allEntries(req, { locals: {} }, onDone);
    allEntries(req, { locals: {} }, onDone);

    expect(Entries.getAll).toHaveBeenCalledTimes(1);
    resolveGetAll();
  });

  it("stores separate entries per referenced field set so a stripped cache entry can't leak into a view that needs more", function (done) {
    const allEntries = loadAllEntries();

    spyOn(Entries, "getAll").and.callFake(function (blogID, options) {
      return Promise.resolve([{ id: "1", title: "A", html: "<p>A body</p>" }]);
    });

    const blog = { id: "blog-1", cacheID: 100 };

    const titleOnlyReq = makeReq(blog, {
      all_entries: { fields: { title: true } },
    });
    const withHtmlReq = makeReq(blog, {
      all_entries: { fields: { title: true, html: true } },
    });

    allEntries(titleOnlyReq, { locals: {} }, function (err, entries) {
      expect(entries[0].html).toBeUndefined();

      allEntries(withHtmlReq, { locals: {} }, function (err, entries2) {
        expect(entries2[0].html).toBe("<p>A body</p>");
        // The title-only fill never held html, so this view can't be served
        // from it and has to refetch.
        expect(Entries.getAll).toHaveBeenCalledTimes(2);
        done();
      });
    });
  });

  it("serves a title-only view from a catalog cached with html, without leaking html", function (done) {
    const allEntries = loadAllEntries();

    spyOn(Entries, "getAll").and.callFake(function (blogID, options) {
      return Promise.resolve([{ id: "1", title: "A", html: "<p>A body</p>" }]);
    });

    const blog = { id: "blog-1", cacheID: 100 };

    const titleOnlyReq = makeReq(blog, {
      all_entries: { fields: { title: true } },
    });
    const withHtmlReq = makeReq(blog, {
      all_entries: { fields: { title: true, html: true } },
    });

    allEntries(withHtmlReq, { locals: {} }, function (err, entries) {
      expect(entries[0].html).toBe("<p>A body</p>");

      allEntries(titleOnlyReq, { locals: {} }, function (err, entries2) {
        expect(entries2[0].title).toBe("A");
        expect(entries2[0].html).toBeUndefined();
        expect(Entries.getAll).toHaveBeenCalledTimes(1);
        done();
      });
    });
  });

  it("shares the catalog, but not its own cache, with preview requests", function (done) {
    const allEntries = loadAllEntries();

    spyOn(Entries, "getAll").and.callFake(function (blogID, options) {
      return Promise.resolve([{ id: "1", title: "A" }]);
    });

    const req = makeReq({ id: "blog-1", cacheID: 100 });
    req.preview = true;

    allEntries(req, { locals: {} }, function () {
      allEntries(req, { locals: {} }, function () {
        expect(Entries.getAll).toHaveBeenCalledTimes(1);
        done();
      });
    });
  });

  it("does not cache an empty result, so a transient Redis failure isn't mistaken for an empty blog", function (done) {
    const allEntries = loadAllEntries();

    // Entries.getAll resolves to [] on a failed zRange/mGet rather than
    // rejecting (see models/entries/index.js getRange's .catch), so an
    // empty array from it is ambiguous between "no posts" and "Redis
    // hiccup." Caching it either way risks hiding every post until the
    // cacheID changes; refetching on every miss is the safe default.
    spyOn(Entries, "getAll").and.callFake(function (blogID, options) {
      return Promise.resolve([]);
    });

    const req = makeReq({ id: "blog-1", cacheID: 100 });

    allEntries(req, { locals: {} }, function () {
      allEntries(req, { locals: {} }, function () {
        expect(Entries.getAll).toHaveBeenCalledTimes(2);
        done();
      });
    });
  });
});

describe("all_entries shared augmentation", function () {
  const Entries = require("models/entries");
  const EntryModel = require("models/entry");
  const Entry = require("models/entry/instance");
  const allEntriesPath = require.resolve("../all_entries");
  const getAllCachedPath = require.resolve("../helpers/getAllCached");

  function loadAllEntries() {
    delete require.cache[allEntriesPath];
    delete require.cache[getAllCachedPath];
    require("models/entries/catalog")._clear();
    return require("../all_entries");
  }

  afterEach(function () {
    delete require.cache[allEntriesPath];
    delete require.cache[getAllCachedPath];
    require("models/entries/catalog")._clear();
  });

  function makeReq(blogURL, cacheID) {
    return {
      blog: {
        id: "blog-1",
        cacheID: cacheID || 100,
        timeZone: "UTC",
        locals: { blogURL: blogURL || "https://example.com" },
      },
      retrieve: {},
      log: function () {},
    };
  }

  function stubCatalog(backlinks) {
    spyOn(Entries, "getAll").and.callFake(function (blogID, options) {
      return Promise.resolve([
        new Entry({
          id: "/a.txt",
          path: "/a.txt",
          url: "/a",
          title: "A",
          tags: ["Foo"],
          dateStamp: Date.UTC(2020, 0, 2),
          backlinks: backlinks || [],
        }),
      ]);
    });
  }

  it("caches entries already augmented and shares their nested fields across hits", async function () {
    const allEntries = loadAllEntries();
    stubCatalog();

    const first = await allEntries(makeReq(), { locals: {} });
    const second = await allEntries(makeReq(), { locals: {} });

    expect(first[0].__augmented).toBe(true);
    expect(first[0].tags[0].slug).toBe("foo");
    expect(second).toBe(first);
    expect(Object.isFrozen(second)).toBe(true);
    expect(Object.isFrozen(second[0])).toBe(true);
    expect(Object.isFrozen(second[0].tags)).toBe(true);
  });

  it("gives each host its own shared copy", async function () {
    const allEntries = loadAllEntries();
    stubCatalog();

    const apex = await allEntries(makeReq("https://example.com"), {
      locals: {},
    });
    const www = await allEntries(makeReq("http://www.example.com"), {
      locals: {},
    });
    const apexAgain = await allEntries(makeReq("https://example.com"), {
      locals: {},
    });

    expect(www[0]).not.toBe(apex[0]);
    expect(www[0].tags).toBe(apex[0].tags);
    expect(apexAgain).toBe(apex);
  });

  it("keeps first/last/position from the fill when loadView skips the shared list", async function () {
    const allEntries = loadAllEntries();
    const loadView = require("../../load");
    stubCatalog();

    const req = makeReq();
    const res = { locals: {} };
    res.locals.all_entries = await allEntries(req, res);
    await loadView(req, res);

    expect(res.locals.all_entries[0].first).toBe(true);
    expect(res.locals.all_entries[0].last).toBe(true);
    expect(res.locals.all_entries[0].position).toBe(1);
  });

  it("computes absoluteURL for the host each request arrived on", async function () {
    const allEntries = loadAllEntries();
    stubCatalog();

    const apex = await allEntries(makeReq("https://example.com"), {
      locals: {},
    });
    const www = await allEntries(makeReq("http://www.example.com"), {
      locals: {},
    });

    expect(apex[0].absoluteURL).toBe("https://example.com/a");
    expect(www[0].absoluteURL).toBe("http://www.example.com/a");
    expect(Entries.getAll).toHaveBeenCalledTimes(1);
  });

  it("keys the cache on the date settings augment reads", async function () {
    const allEntries = loadAllEntries();
    stubCatalog();

    const long = await allEntries(makeReq(), { locals: {} });
    const yearOnly = await allEntries(makeReq(), {
      locals: { date_display: "YYYY" },
    });
    const hidden = await allEntries(makeReq(), {
      locals: { hide_dates: true },
    });

    expect(long[0].date).toBe("January 2, 2020");
    expect(yearOnly[0].date).toBe("2020");
    expect(hidden[0].date).toBeUndefined();
  });

  it("keys the cache on whether the view can use backlinks", function () {
    const { augmentContext } = require("../../load/augmentedEntries");
    const allEntries = loadAllEntries();
    const blog = makeReq().blog;
    const res = { locals: {} };

    const keyFor = (usesBacklinks) =>
      allEntries._createCacheKey(
        blog,
        {},
        augmentContext({ blog, usesBacklinks }, res)
      );

    expect(keyFor(false)).not.toEqual(keyFor(undefined));
    expect(keyFor(false)).not.toEqual(keyFor(true));
    expect(keyFor(undefined)).toEqual(keyFor(true));
  });

  it("does not hand a fill made without backlinks to a view that uses them", async function () {
    const allEntries = loadAllEntries();
    stubCatalog(["/b"]);

    spyOn(EntryModel, "getByUrl").and.callFake(function (blogID, url) {
      return Promise.resolve(
        new Entry({ id: "/b.txt", path: "/b.txt", url: "/b", title: "B" })
      );
    });

    const without = makeReq();
    without.usesBacklinks = false;
    const withBacklinks = makeReq();
    withBacklinks.usesBacklinks = true;

    const first = await allEntries(without, { locals: {} });
    const second = await allEntries(withBacklinks, { locals: {} });

    expect(first[0].backlinks).toEqual([]);
    expect(second[0].backlinks.map((entry) => entry.title)).toEqual(["B"]);
    expect(EntryModel.getByUrl).toHaveBeenCalledTimes(1);
  });

  it("resolves backlinks once per fill, not per render", async function () {
    const allEntries = loadAllEntries();
    stubCatalog(["/b"]);

    spyOn(EntryModel, "getByUrl").and.callFake(function (blogID, url) {
      return Promise.resolve(
        new Entry({ id: "/b.txt", path: "/b.txt", url: "/b", title: "B" })
      );
    });

    const first = await allEntries(makeReq(), { locals: {} });
    await allEntries(makeReq(), { locals: {} });

    expect(first[0].backlinks.map((entry) => entry.title)).toEqual(["B"]);
    expect(EntryModel.getByUrl).toHaveBeenCalledTimes(1);
  });

  it("does not cache a fill in which a backlink lookup hit a Redis error", async function () {
    const allEntries = loadAllEntries();
    stubCatalog(["/b"]);

    spyOn(EntryModel, "getByUrl").and.callFake(function (blogID, url) {
      return Promise.reject(new Error("mGet failed"));
    });

    const first = await allEntries(makeReq(), { locals: {} });
    await allEntries(makeReq(), { locals: {} });

    expect(first[0].backlinks).toEqual([]);
    expect(EntryModel.getByUrl).toHaveBeenCalledTimes(2);
  });

  it("still caches a fill whose backlinks point at entries that no longer exist", async function () {
    const allEntries = loadAllEntries();
    stubCatalog(["/deleted"]);

    spyOn(EntryModel, "getByUrl").and.callFake(function (blogID, url) {
      return Promise.resolve();
    });

    await allEntries(makeReq(), { locals: {} });
    await allEntries(makeReq(), { locals: {} });

    expect(EntryModel.getByUrl).toHaveBeenCalledTimes(1);
  });

  it("surfaces an augmentation failure as a template error through retrieve(), not a page missing all_entries", async function () {
    loadAllEntries();
    const retrievePath = require.resolve("../index");
    delete require.cache[retrievePath];
    const retrieve = require("../index");

    spyOn(Entries, "getAll").and.callFake(function (blogID, options) {
      // tags must be an array - augment() reads tags.length
      return Promise.resolve([
        new Entry({ id: "/a.txt", path: "/a.txt", url: "/a" }),
      ]);
    });

    let error;
    try {
      await retrieve(makeReq(), { locals: {} }, { all_entries: {} });
    } catch (e) {
      error = e;
    }

    delete require.cache[retrievePath];
    expect(error && error.code).toBe("BADTEMPLATE");
    expect(error && error.message).toBe(
      "Your template variables were badly called"
    );
  });
});
