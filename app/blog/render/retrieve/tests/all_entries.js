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

    spyOn(Entries, "getAll").and.callFake(function (blogID, callback) {
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

    spyOn(Entries, "getAll").and.callFake(function (blogID, callback) {
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

    spyOn(Entries, "getAll").and.callFake(function (blogID, callback) {
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
    spyOn(Entries, "getAll").and.callFake(function (blogID, callback) {
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

    spyOn(Entries, "getAll").and.callFake(function (blogID, callback) {
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

    spyOn(Entries, "getAll").and.callFake(function (blogID, callback) {
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
    spyOn(Entries, "getAll").and.callFake(function (blogID, callback) {
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
