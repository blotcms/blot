describe("all_entries", function () {
  require("blog/tests/util/setup")();

  it("renders every entry", async function () {
    await this.write({ path: "/a.txt", content: "Title: A\n\nA body" });
    await this.write({ path: "/b.txt", content: "Title: B\n\nB body" });

    await this.template(
      { "list.html": `{{#allEntries}}{{title}} {{/allEntries}}` },
      { views: { "list.html": { url: "/list" } } }
    );

    const res = await this.get("/list");
    expect((await res.text()).trim().split(/\s+/).sort()).toEqual(["A", "B"]);
  });

  it("drops unreferenced heavy fields from allEntries locals", async function () {
    await this.write({ path: "/a.txt", content: "Title: A\n\nA body" });

    await this.template(
      { "list.html": `{{#allEntries}}{{title}} {{url}}{{/allEntries}}` },
      { views: { "list.html": { url: "/list" } } }
    );

    const res = await this.get("/list?json=1");
    const locals = await res.json();

    expect(locals.allEntries.length).toEqual(1);
    expect(locals.allEntries[0].title).toEqual("A");
    expect(locals.allEntries[0].url).toBeDefined();
    expect(locals.allEntries[0].html).toBeUndefined();
    expect(locals.allEntries[0].body).toBeUndefined();
    expect(locals.allEntries[0].summary).toBeUndefined();
  });

  it("keeps entry html when the view renders it", async function () {
    await this.write({ path: "/a.txt", content: "Title: A\n\nA body" });

    await this.template(
      { "list.html": `{{#allEntries}}{{{html}}}{{/allEntries}}` },
      { views: { "list.html": { url: "/list" } } }
    );

    const res = await this.get("/list?json=1");
    const locals = await res.json();

    expect(locals.allEntries[0].html).toContain("A body");
  });

  it("keeps entry body when it is wrapped in an encoder helper", async function () {
    await this.write({ path: "/a.txt", content: "Title: A\n\nA body" });

    await this.template(
      {
        "list.html": `{{#allEntries}}{{#encode_xml}}{{{body}}}{{/encode_xml}}{{/allEntries}}`,
      },
      { views: { "list.html": { url: "/list" } } }
    );

    const res = await this.get("/list?json=1");
    const locals = await res.json();

    expect(locals.allEntries[0].body).toContain("A body");

    const rendered = await (await this.get("/list")).text();
    expect(rendered).toContain("A body");
  });

  it("does not treat a template-level string local as a nested template", async function () {
    await this.write({ path: "/a.txt", content: "Title: A\n\nA body" });

    await this.template(
      { "list.html": `{{#allEntries}}{{title}}{{/allEntries}}{{{snippet}}}` },
      {
        views: { "list.html": { url: "/list" } },
        locals: { snippet: "{{#allEntries}}{{{html}}} {{/allEntries}}" },
      }
    );

    const locals = await (await this.get("/list?json=1")).json();
    expect(locals.allEntries[0].html).toBeUndefined();

    const rendered = await (await this.get("/list")).text();
    expect(rendered).toContain("{{#allEntries}}{{{html}}} {{/allEntries}}");
    expect(rendered).not.toContain("A body");
  });

  it("does not treat a query string local as a nested template", async function () {
    await this.write({ path: "/a.txt", content: "Title: A\n\nA body" });

    await this.template(
      { "list.html": `{{#allEntries}}{{title}}{{/allEntries}}{{{query.snippet}}}` },
      { views: { "list.html": { url: "/list" } } }
    );

    const snippet = encodeURIComponent(
      "{{#allEntries}}{{{html}}} {{/allEntries}}"
    );
    const locals = await (
      await this.get("/list?json=1&snippet=" + snippet)
    ).json();

    expect(locals.allEntries[0].html).toBeUndefined();
  });
});

describe("all_entries cache", function () {
  const Entries = require("models/entries");
  const allEntriesPath = require.resolve("../all_entries");
  const getAllCachedPath = require.resolve("../helpers/getAllCached");

  function loadAllEntries() {
    delete require.cache[allEntriesPath];
    delete require.cache[getAllCachedPath];
    return require("../all_entries");
  }

  afterEach(function () {
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

  it("reuses cached entries for identical cacheIDs", function (done) {
    const allEntries = loadAllEntries();

    spyOn(Entries, "getAll").and.callFake(function (blogID, options, callback) {
      callback([{ id: "1", title: "A" }]);
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

    spyOn(Entries, "getAll").and.callFake(function (blogID, options, callback) {
      callback([{ id: "1", title: "A" }]);
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

    spyOn(Entries, "getAll").and.callFake(function (blogID, options, callback) {
      callback([{ id: "1", title: "Original" }]);
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
    spyOn(Entries, "getAll").and.callFake(function (blogID, options, callback) {
      resolveGetAll = () => callback([{ id: "1", title: "A" }]);
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

    spyOn(Entries, "getAll").and.callFake(function (blogID, options, callback) {
      callback([{ id: "1", title: "A", html: "<p>A body</p>" }]);
    });

    const blog = { id: "blog-1", cacheID: 100 };

    const titleOnlyReq = makeReq(blog, {
      allEntries: { fields: { title: true } },
    });
    const withHtmlReq = makeReq(blog, {
      allEntries: { fields: { title: true, html: true } },
    });

    allEntries(titleOnlyReq, { locals: {} }, function (err, entries) {
      expect(entries[0].html).toBeUndefined();

      allEntries(withHtmlReq, { locals: {} }, function (err, entries2) {
        expect(entries2[0].html).toBe("<p>A body</p>");
        expect(Entries.getAll).toHaveBeenCalledTimes(1);
        done();
      });
    });
  });

  it("bypasses the cache for preview requests", function (done) {
    const allEntries = loadAllEntries();

    spyOn(Entries, "getAll").and.callFake(function (blogID, options, callback) {
      callback([{ id: "1", title: "A" }]);
    });

    const req = makeReq({ id: "blog-1", cacheID: 100 });
    req.preview = true;

    allEntries(req, { locals: {} }, function () {
      allEntries(req, { locals: {} }, function () {
        expect(Entries.getAll).toHaveBeenCalledTimes(2);
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
    spyOn(Entries, "getAll").and.callFake(function (blogID, options, callback) {
      callback([]);
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
    return require("../all_entries");
  }

  afterEach(function () {
    delete require.cache[allEntriesPath];
    delete require.cache[getAllCachedPath];
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
    spyOn(Entries, "getAll").and.callFake(function (blogID, options, callback) {
      callback([
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
    expect(second[0]).not.toBe(first[0]);
    expect(second[0].tags).toBe(first[0].tags);
    expect(Object.isFrozen(second[0].tags)).toBe(true);
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

    spyOn(EntryModel, "getByUrl").and.callFake(function (blogID, url, callback) {
      callback(new Entry({ id: "/b.txt", path: "/b.txt", url: "/b", title: "B" }));
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

    spyOn(EntryModel, "getByUrl").and.callFake(function (blogID, url, callback) {
      callback(new Entry({ id: "/b.txt", path: "/b.txt", url: "/b", title: "B" }));
    });

    const first = await allEntries(makeReq(), { locals: {} });
    await allEntries(makeReq(), { locals: {} });

    expect(first[0].backlinks.map((entry) => entry.title)).toEqual(["B"]);
    expect(EntryModel.getByUrl).toHaveBeenCalledTimes(1);
  });

  it("does not cache a fill in which a backlink lookup hit a Redis error", async function () {
    const allEntries = loadAllEntries();
    stubCatalog(["/b"]);

    spyOn(EntryModel, "getByUrl").and.callFake(function (blogID, url, callback) {
      callback(undefined, new Error("mGet failed"));
    });

    const first = await allEntries(makeReq(), { locals: {} });
    await allEntries(makeReq(), { locals: {} });

    expect(first[0].backlinks).toEqual([]);
    expect(EntryModel.getByUrl).toHaveBeenCalledTimes(2);
  });

  it("still caches a fill whose backlinks point at entries that no longer exist", async function () {
    const allEntries = loadAllEntries();
    stubCatalog(["/deleted"]);

    spyOn(EntryModel, "getByUrl").and.callFake(function (blogID, url, callback) {
      callback();
    });

    await allEntries(makeReq(), { locals: {} });
    await allEntries(makeReq(), { locals: {} });

    expect(EntryModel.getByUrl).toHaveBeenCalledTimes(1);
  });

  it("surfaces an augmentation failure as a template error through retrieve(), not a page missing allEntries", async function () {
    loadAllEntries();
    const retrievePath = require.resolve("../index");
    delete require.cache[retrievePath];
    const retrieve = require("../index");

    spyOn(Entries, "getAll").and.callFake(function (blogID, options, callback) {
      // tags must be an array - augment() reads tags.length
      callback([new Entry({ id: "/a.txt", path: "/a.txt", url: "/a" })]);
    });

    let error;
    try {
      await retrieve(makeReq(), { locals: {} }, { allEntries: {} });
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
