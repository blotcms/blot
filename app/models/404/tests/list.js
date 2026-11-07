describe("404 list", function () {
  global.test.blog();

  const set = require("../set");
  const ignore = require("../ignore");
  const list = require("../list");

  beforeEach(async function () {
    for (const url of ["/a", "/b", "/c", "/d"]) {
      await set(this.blog.id, url);
      await new Promise((r) => setTimeout(r, 5));
    }
    await ignore(this.blog.id, "/b");
  });

  it("lists every entry, newest first, split by the ignore set", async function () {
    const { list: items, ignored, totals } = await list(this.blog.id);

    expect(items.map((i) => i.url)).toEqual(["/d", "/c", "/a"]);
    expect(ignored.map((i) => i.url)).toEqual(["/b"]);
    expect(totals).toEqual({ list: 3, ignored: 1 });
    expect(typeof items[0].time).toBe("string");
  });

  it("returns at most limit entries in each bucket, with full totals", async function () {
    const {
      list: items,
      ignored,
      totals,
    } = await list(this.blog.id, { limit: 2 });

    expect(items.map((i) => i.url)).toEqual(["/d", "/c"]);
    expect(ignored.map((i) => i.url)).toEqual(["/b"]);
    expect(totals).toEqual({ list: 3, ignored: 1 });
  });
});
