describe("tags.get", function () {
  const set = require("../set");
  const get = require("../get");

  async function setAsync(blogID, entry) {
    await set(blogID, entry);
  }

  // Create a test user and blog before each spec
  global.test.blog();

  it("can be invoked without error", async function () {
    const blogID = this.blog.id;
    const entry = { id: "entry1", blogID, path: "/entry1", tags: ["tag1"] };

    await setAsync(blogID, entry);

    const { entryIDs, prettyTag, total } = await get(blogID, "tag1");

    expect(entryIDs).toEqual([entry.id]);
    expect(prettyTag).toEqual("tag1");
    expect(total).toEqual(1);
  });

  it("finds a tag by the name it was entered with", async function () {
    const blogID = this.blog.id;

    await setAsync(blogID, {
      id: "decoded",
      blogID,
      path: "/decoded",
      tags: ["Hello World"],
    });

    const result = await get(blogID, "Hello World");

    expect(result.entryIDs).toEqual(["decoded"]);
    expect(result.prettyTag).toEqual("Hello World");
  });

  it("resolves to empty results for an unknown tag", async function () {
    const result = await get(this.blog.id, "nothing-here");

    expect(result).toEqual({
      entryIDs: [],
      prettyTag: "nothing-here",
      total: 0,
    });
  });

  it("returns entries sorted by dateStamp when limited", async function () {
    const blogID = this.blog.id;
    const entries = [
      {
        id: "entry-a",
        blogID,
        path: "/entry-a",
        tags: ["Tag One"],
        dateStamp: 1000,
      },
      {
        id: "entry-b",
        blogID,
        path: "/entry-b",
        tags: ["Tag One"],
        dateStamp: 3000,
      },
      {
        id: "entry-c",
        blogID,
        path: "/entry-c",
        tags: ["Tag One"],
        dateStamp: 2000,
      },
    ];

    for (const entry of entries) await setAsync(blogID, entry);

    const { entryIDs, prettyTag, total } = await get(blogID, "Tag One", {
      limit: 2,
    });

    expect(entryIDs).toEqual(["entry-b", "entry-c"]);
    expect(prettyTag).toEqual("Tag One");
    expect(total).toEqual(3);
  });

  it("returns oldest-first when rev is false", async function () {
    const blogID = this.blog.id;
    const entries = [
      { id: "old", blogID, path: "/old", tags: ["Tag Rev"], dateStamp: 1000 },
      { id: "mid", blogID, path: "/mid", tags: ["Tag Rev"], dateStamp: 2000 },
      { id: "new", blogID, path: "/new", tags: ["Tag Rev"], dateStamp: 3000 },
    ];

    for (const entry of entries) await setAsync(blogID, entry);

    const { entryIDs } = await get(blogID, "Tag Rev", { rev: false, limit: 2 });

    expect(entryIDs).toEqual(["old", "mid"]);
  });

  it("supports offsets for pagination", async function () {
    const blogID = this.blog.id;
    const entries = [
      {
        id: "entry-d",
        blogID,
        path: "/entry-d",
        tags: ["Tag Two"],
        dateStamp: 1000,
      },
      {
        id: "entry-e",
        blogID,
        path: "/entry-e",
        tags: ["Tag Two"],
        dateStamp: 4000,
      },
      {
        id: "entry-f",
        blogID,
        path: "/entry-f",
        tags: ["Tag Two"],
        dateStamp: 3000,
      },
    ];

    for (const entry of entries) await setAsync(blogID, entry);

    const { entryIDs, prettyTag } = await get(blogID, "Tag Two", {
      offset: 1,
      limit: 1,
    });

    expect(entryIDs).toEqual(["entry-f"]);
    expect(prettyTag).toEqual("Tag Two");
  });
});
