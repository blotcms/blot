describe("google drive dirty directories", function () {
  const client = require("models/client");
  const dirty = require("clients/google-drive/database/dirty");

  const BLOG = "blog_dirty_test";

  afterEach(async function () {
    await client.del(dirty.key(BLOG));
  });

  it("takes every directory added, once", async function () {
    await dirty.add(BLOG, ["a", "b"]);
    await dirty.add(BLOG, ["b", "c"]);

    expect(await dirty.count(BLOG)).toBe(3);
    expect((await dirty.take(BLOG)).sort()).toEqual(["a", "b", "c"]);
    expect(await dirty.take(BLOG)).toEqual([]);
    expect(await dirty.count(BLOG)).toBe(0);
  });

  it("leaves what is added after a take for the next one", async function () {
    await dirty.add(BLOG, ["a"]);
    await dirty.take(BLOG);
    await dirty.add(BLOG, [dirty.FULL]);

    expect(await dirty.take(BLOG)).toEqual([dirty.FULL]);
  });

  it("expires a set nobody takes", async function () {
    await dirty.add(BLOG, ["a"]);

    expect(await client.ttl(dirty.key(BLOG))).toBeGreaterThan(0);
  });

  it("adds nothing for no directories", async function () {
    await dirty.add(BLOG, []);

    expect(await client.exists(dirty.key(BLOG))).toBe(0);
  });
});
