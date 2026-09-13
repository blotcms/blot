describe("latest_entry", function () {
  require("blog/tests/util/setup")();

  it("exposes the most recent entry", async function () {
    await this.write({
      path: "/old.txt",
      content: "Title: Old\nDate: 2020-01-01\n\nOld body",
    });
    await this.write({
      path: "/new.txt",
      content: "Title: New\nDate: 2021-01-01\n\nNew body",
    });

    await this.template(
      { "home.html": `{{#latestEntry}}{{title}}{{/latestEntry}}` },
      { views: { "home.html": { url: "/home" } } }
    );

    expect((await (await this.get("/home")).text()).trim()).toEqual("New");
  });

  it("drops unreferenced heavy fields from latestEntry", async function () {
    await this.write({ path: "/a.txt", content: "Title: A\n\nA body" });

    await this.template(
      { "home.html": `{{#latestEntry}}{{title}} {{url}}{{/latestEntry}}` },
      { views: { "home.html": { url: "/home" } } }
    );

    const locals = await (await this.get("/home?json=1")).json();

    expect(locals.latestEntry.title).toEqual("A");
    expect(locals.latestEntry.url).toBeDefined();
    expect(locals.latestEntry.html).toBeUndefined();
    expect(locals.latestEntry.summary).toBeUndefined();
  });

  it("keeps latestEntry html when the view renders it", async function () {
    await this.write({ path: "/a.txt", content: "Title: A\n\nA body" });

    await this.template(
      { "home.html": `{{#latestEntry}}{{{html}}}{{/latestEntry}}` },
      { views: { "home.html": { url: "/home" } } }
    );

    const locals = await (await this.get("/home?json=1")).json();
    expect(locals.latestEntry.html).toContain("A body");
  });

  it("reuses the latest entry across requests for the same cacheID", async function () {
    await this.write({ path: "/a.txt", content: "Title: A\n\nA body" });

    await this.template(
      { "home.html": `{{#latestEntry}}{{title}}{{/latestEntry}}` },
      { views: { "home.html": { url: "/home" } } }
    );

    const entriesModel = require("models/entries");
    spyOn(entriesModel, "getPage").and.callThrough();

    const first = await this.get("/home");
    expect((await first.text()).trim()).toEqual("A");
    const callsAfterFirst = entriesModel.getPage.calls.count();
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = await this.get("/home");
    expect((await second.text()).trim()).toEqual("A");
    expect(entriesModel.getPage.calls.count()).toEqual(callsAfterFirst);
  });
});

describe("latest_entry cache", function () {
  const latestEntry = require("../latest_entry");
  const entriesModel = require("models/entries");

  beforeEach(function () {
    latestEntry._clear();
  });

  function makeReq(blog, retrieve) {
    return {
      blog,
      retrieve: retrieve || {},
      log: function () {},
    };
  }

  it("reuses cached entries for identical cacheIDs", function (done) {
    spyOn(entriesModel, "getPage").and.callFake(function (blogID, options, callback) {
      callback(null, [{ id: "1", title: "A" }], { page: 1, pages: 1 });
    });

    const req = makeReq({ id: "blog-1", cacheID: 100 });

    latestEntry(req, {}, function () {
      latestEntry(req, {}, function () {
        expect(entriesModel.getPage).toHaveBeenCalledTimes(1);
        done();
      });
    });
  });

  it("refetches when cacheID changes", function (done) {
    spyOn(entriesModel, "getPage").and.callFake(function (blogID, options, callback) {
      callback(null, [{ id: "1", title: "A" }], { page: 1, pages: 1 });
    });

    latestEntry(makeReq({ id: "blog-1", cacheID: 100 }), {}, function () {
      latestEntry(makeReq({ id: "blog-1", cacheID: 101 }), {}, function () {
        expect(entriesModel.getPage).toHaveBeenCalledTimes(2);
        done();
      });
    });
  });

  it("returns isolated copies so caller mutations do not taint cache", function (done) {
    spyOn(entriesModel, "getPage").and.callFake(function (blogID, options, callback) {
      callback(null, [{ id: "1", title: "Original" }], { page: 1, pages: 1 });
    });

    const req = makeReq({ id: "blog-1", cacheID: 100 });

    latestEntry(req, {}, function (err, first) {
      first.title = "Mutated";

      latestEntry(req, {}, function (err, second) {
        expect(second.title).toBe("Original");
        done();
      });
    });
  });

  it("still projects heavy fields on a cache hit", function (done) {
    spyOn(entriesModel, "getPage").and.callFake(function (blogID, options, callback) {
      callback(
        null,
        [{ id: "1", title: "A", html: "<p>A body</p>" }],
        { page: 1, pages: 1 }
      );
    });

    const req = makeReq(
      { id: "blog-1", cacheID: 100 },
      { latestEntry: { fields: { title: true } } }
    );

    latestEntry(req, {}, function (err, first) {
      expect(first.html).toBeUndefined();

      latestEntry(req, {}, function (err, second) {
        expect(second.title).toBe("A");
        expect(second.html).toBeUndefined();
        expect(entriesModel.getPage).toHaveBeenCalledTimes(1);
        done();
      });
    });
  });

  it("does not cache an empty result, so a failed hydration isn't mistaken for an empty blog", function (done) {
    spyOn(entriesModel, "getPage").and.callFake(function (blogID, options, callback) {
      callback(null, [], { page: 1, pages: 1, totalEntries: 1 });
    });

    const req = makeReq({ id: "blog-1", cacheID: 100 });

    latestEntry(req, {}, function () {
      latestEntry(req, {}, function () {
        expect(entriesModel.getPage).toHaveBeenCalledTimes(2);
        done();
      });
    });
  });
});
