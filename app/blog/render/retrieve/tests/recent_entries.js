const recentEntries = require("../recent_entries");
const Entries = require("models/entries");

describe("recent_entries", function () {
  beforeEach(function () {
    recentEntries._clear();
  });

  function run(req) {
    return new Promise((resolve, reject) => {
      recentEntries(req, {}, (err, result) =>
        err ? reject(err) : resolve(result)
      );
    });
  }

  it("fetches the full entry list when no field projection metadata is present", async function () {
    spyOn(Entries, "getRecent").and.callFake(function (blogID, options, callback) {
      callback([{ id: "/a.txt", title: "A", html: "<p>A</p>" }]);
    });

    const result = await run({ blog: { id: "blog-1" }, retrieve: {} });

    expect(Entries.getRecent).toHaveBeenCalledWith(
      "blog-1",
      jasmine.any(Object),
      jasmine.any(Function)
    );
    expect(result).toEqual([{ id: "/a.txt", title: "A", html: "<p>A</p>" }]);
  });

  it("strips unreferenced heavy fields when the template only references non-heavy fields", async function () {
    spyOn(Entries, "getRecent").and.callFake(function (blogID, options, callback) {
      callback([{ id: "/a.txt", title: "A", html: "<p>A</p>" }]);
    });

    const result = await run({
      blog: { id: "blog-1" },
      retrieve: { recentEntries: { fields: { title: true } } },
    });

    // The template only referenced `title`, so the unreferenced heavy `html`
    // field should be stripped even though the fetch above returned it.
    expect(result).toEqual([{ id: "/a.txt", title: "A" }]);
  });

  it("recognizes the recent_entries alias", async function () {
    spyOn(Entries, "getRecent").and.callFake(function (blogID, options, callback) {
      callback([{ id: "/a.txt", title: "A", html: "<p>A</p>" }]);
    });

    const result = await run({
      blog: { id: "blog-1" },
      retrieve: { recent_entries: { fields: { title: true } } },
    });

    expect(result).toEqual([{ id: "/a.txt", title: "A" }]);
  });
});

describe("recent_entries cache", function () {
  const recentEntries = require("../recent_entries");
  const Entries = require("models/entries");

  beforeEach(function () {
    recentEntries._clear();
  });

  function run(req) {
    return new Promise((resolve, reject) => {
      recentEntries(req, {}, (err, result) =>
        err ? reject(err) : resolve(result)
      );
    });
  }

  function makeReq(blog, retrieve) {
    return {
      blog,
      retrieve: retrieve || {},
      log: function () {},
    };
  }

  it("reuses cached entries for identical cacheIDs", function (done) {
    spyOn(Entries, "getRecent").and.callFake(function (blogID, options, callback) {
      callback([{ id: "1", title: "A" }]);
    });

    const req = makeReq({ id: "blog-1", cacheID: 100 });

    recentEntries(req, {}, function () {
      recentEntries(req, {}, function () {
        expect(Entries.getRecent).toHaveBeenCalledTimes(1);
        done();
      });
    });
  });

  it("refetches when cacheID changes", function (done) {
    spyOn(Entries, "getRecent").and.callFake(function (blogID, options, callback) {
      callback([{ id: "1", title: "A" }]);
    });

    recentEntries(makeReq({ id: "blog-1", cacheID: 100 }), {}, function () {
      recentEntries(makeReq({ id: "blog-1", cacheID: 101 }), {}, function () {
        expect(Entries.getRecent).toHaveBeenCalledTimes(2);
        done();
      });
    });
  });

  it("returns isolated copies so caller mutations do not taint cache", function (done) {
    spyOn(Entries, "getRecent").and.callFake(function (blogID, options, callback) {
      callback([{ id: "1", title: "Original" }]);
    });

    const req = makeReq({ id: "blog-1", cacheID: 100 });

    recentEntries(req, {}, function (err, first) {
      first[0].title = "Mutated";

      recentEntries(req, {}, function (err, second) {
        expect(second[0].title).toBe("Original");
        done();
      });
    });
  });

  it("does not cache an empty result, so a transient Redis failure isn't mistaken for an empty blog", function (done) {
    spyOn(Entries, "getRecent").and.callFake(function (blogID, options, callback) {
      callback([]);
    });

    const req = makeReq({ id: "blog-1", cacheID: 100 });

    recentEntries(req, {}, function () {
      recentEntries(req, {}, function () {
        expect(Entries.getRecent).toHaveBeenCalledTimes(2);
        done();
      });
    });
  });

  it("still projects heavy fields on a cache hit", async function () {
    spyOn(Entries, "getRecent").and.callFake(function (blogID, options, callback) {
      callback([{ id: "/a.txt", title: "A", html: "<p>A</p>" }]);
    });

    const req = makeReq(
      { id: "blog-1", cacheID: 100 },
      { recentEntries: { fields: { title: true } } }
    );

    await run(req);
    const result = await run(req);

    expect(Entries.getRecent).toHaveBeenCalledTimes(1);
    expect(result).toEqual([{ id: "/a.txt", title: "A" }]);
  });
});

describe("recent_entries rendering", function () {
  require("blog/tests/util/setup")();

  it("reuses recent entries across requests for the same cacheID", async function () {
    await this.write({ path: "/a.txt", content: "Title: A\n\nA body" });
    await this.write({ path: "/b.txt", content: "Title: B\n\nB body" });

    await this.template(
      { "home.html": `{{#recent_entries}}{{title}} {{/recent_entries}}` },
      { views: { "home.html": { url: "/home" } } }
    );

    const Entries = require("models/entries");
    spyOn(Entries, "getRecent").and.callThrough();

    const first = await this.get("/home");
    const firstBody = (await first.text()).trim();
    expect(first.status).toEqual(200);
    expect(firstBody).toContain("A");
    expect(firstBody).toContain("B");

    const callsAfterFirst = Entries.getRecent.calls.count();
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = await this.get("/home");
    expect(second.status).toEqual(200);
    expect((await second.text()).trim()).toEqual(firstBody);
    expect(Entries.getRecent.calls.count()).toEqual(callsAfterFirst);
  });
});
