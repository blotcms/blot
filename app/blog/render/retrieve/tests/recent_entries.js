const recentEntries = require("../recent_entries");
const Entries = require("models/entries");
const cachedRecent = require("models/entries/cachedRecent");

describe("recent_entries", function () {
  beforeEach(function () {
    cachedRecent._clear();
  });

  function run(req) {
    return recentEntries(req, {});
  }

  it("fetches the full entry list when no field projection metadata is present", async function () {
    spyOn(Entries, "getRecent").and.callFake(function () {
      return Promise.resolve([{ id: "/a.txt", title: "A", html: "<p>A</p>" }]);
    });

    const result = await run({
      blog: { id: "blog-1", cacheID: 1 },
      retrieve: {},
    });

    expect(Entries.getRecent).toHaveBeenCalledWith(
      "blog-1",
      jasmine.any(Object)
    );
    expect(result).toEqual([{ id: "/a.txt", title: "A", html: "<p>A</p>" }]);
  });

  it("strips unreferenced heavy fields when the template only references non-heavy fields", async function () {
    spyOn(Entries, "getRecent").and.callFake(function () {
      return Promise.resolve([{ id: "/a.txt", title: "A", html: "<p>A</p>" }]);
    });

    const result = await run({
      blog: { id: "blog-1", cacheID: 1 },
      retrieve: { recent_entries: { fields: { title: true } } },
    });

    // The template only referenced `title`, so the unreferenced heavy `html`
    // field should be stripped even though the fetch above returned it.
    expect(result).toEqual([{ id: "/a.txt", title: "A" }]);
  });

  it("recognizes the recent_entries alias", async function () {
    spyOn(Entries, "getRecent").and.callFake(function () {
      return Promise.resolve([{ id: "/a.txt", title: "A", html: "<p>A</p>" }]);
    });

    const result = await run({
      blog: { id: "blog-1", cacheID: 1 },
      retrieve: { recent_entries: { fields: { title: true } } },
    });

    expect(result).toEqual([{ id: "/a.txt", title: "A" }]);
  });
});

describe("recent_entries cache", function () {
  const recentEntries = require("../recent_entries");
  const Entries = require("models/entries");
  const cachedRecent = require("models/entries/cachedRecent");

  beforeEach(function () {
    cachedRecent._clear();
  });

  function run(req) {
    return recentEntries(req, {});
  }

  function makeReq(blog, retrieve) {
    return {
      blog,
      retrieve: retrieve || {},
      log: function () {},
    };
  }

  it("reuses cached entries for identical cacheIDs", async function () {
    spyOn(Entries, "getRecent").and.callFake(function () {
      return Promise.resolve([{ id: "1", title: "A" }]);
    });

    const req = makeReq({ id: "blog-1", cacheID: 100 });

    await recentEntries(req, {});
    await recentEntries(req, {});
    expect(Entries.getRecent).toHaveBeenCalledTimes(1);
  });

  it("refetches when cacheID changes", async function () {
    spyOn(Entries, "getRecent").and.callFake(function () {
      return Promise.resolve([{ id: "1", title: "A" }]);
    });

    await recentEntries(makeReq({ id: "blog-1", cacheID: 100 }), {});
    await recentEntries(makeReq({ id: "blog-1", cacheID: 101 }), {});
    expect(Entries.getRecent).toHaveBeenCalledTimes(2);
  });

  it("returns isolated copies so caller mutations do not taint cache", async function () {
    spyOn(Entries, "getRecent").and.callFake(function () {
      return Promise.resolve([{ id: "1", title: "Original" }]);
    });

    const req = makeReq({ id: "blog-1", cacheID: 100 });

    const first = await recentEntries(req, {});
    first[0].title = "Mutated";

    const second = await recentEntries(req, {});
    expect(second[0].title).toBe("Original");
  });

  it("does not cache an empty result, so a transient Redis failure isn't mistaken for an empty blog", async function () {
    spyOn(Entries, "getRecent").and.callFake(function () {
      return Promise.resolve([]);
    });

    const req = makeReq({ id: "blog-1", cacheID: 100 });

    await recentEntries(req, {});
    await recentEntries(req, {});
    expect(Entries.getRecent).toHaveBeenCalledTimes(2);
  });

  it("still projects heavy fields on a cache hit", async function () {
    spyOn(Entries, "getRecent").and.callFake(function () {
      return Promise.resolve([{ id: "/a.txt", title: "A", html: "<p>A</p>" }]);
    });

    const req = makeReq(
      { id: "blog-1", cacheID: 100 },
      { recent_entries: { fields: { title: true } } }
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

describe("recent_entries feed length", function () {
  const recentEntries = require("../recent_entries");
  const Entries = require("models/entries");
  const cachedRecent = require("models/entries/cachedRecent");

  function run(req) {
    return recentEntries(req, {});
  }

  function thirty() {
    return Array.from({ length: 30 }, (_, i) => ({
      id: "/" + i + ".txt",
      title: "Entry " + i,
    }));
  }

  async function entriesFor(viewName) {
    cachedRecent._clear();
    if (!jasmine.isSpy(Entries.getRecent)) {
      spyOn(Entries, "getRecent").and.callFake(function () {
        return Promise.resolve(thirty());
      });
    }
    return run({
      blog: { id: "blog-1", cacheID: "1" },
      viewName,
      retrieve: {},
    });
  }

  it("gives feed.rss at most FEED_MAX_ENTRIES entries", async function () {
    expect(recentEntries.FEED_MAX_ENTRIES).toBe(10);
    const result = await entriesFor("feed.rss");
    expect(result.length).toBe(10);
    expect(result[0].id).toBe("/0.txt");
  });

  it("gives an HTML view all 30 entries", async function () {
    expect((await entriesFor("sidebar.html")).length).toBe(30);
  });

  it("gives other xml views all 30 entries", async function () {
    expect((await entriesFor("sitemap.xml")).length).toBe(30);
    expect((await entriesFor("atom.xml")).length).toBe(30);
  });

  it("does not shrink the cached entries for later views", async function () {
    await entriesFor("feed.rss");
    const result = await run({
      blog: { id: "blog-1", cacheID: "1" },
      viewName: "index.html",
      retrieve: {},
    });
    expect(result.length).toBe(30);
  });
});
