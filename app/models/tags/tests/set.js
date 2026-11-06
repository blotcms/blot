describe("tags.set", function () {
  const { promisify } = require("util");
  const set = promisify(require("../set"));
  const get = require("../get");

  // Create a test user and blog before each spec
  global.test.blog();

  it("can be invoked without error", async function () {
    const entry = {
      id: "entry1",
      blogID: "blog1",
      path: "/entry1",
      tags: ["tag1"],
    };

    const result = await set(this.blog.id, entry);
    // The entry is now on tag1, which other entries' pages render
    expect(result).toEqual({ changed: true });
  });

  ["page", "menu"].forEach(function (property) {
    it(
      "does not index a newly created tagged " + property + " entry",
      async function () {
        const entry = {
          id: property + "-entry",
          blogID: this.blog.id,
          path: "/" + property + "-entry",
          tags: ["automotive"],
        };
        entry[property] = true;

        await set(this.blog.id, entry);

        const { entryIDs } = await get(this.blog.id, "automotive");
        expect(entryIDs).toEqual([]);
      }
    );
  });

  it("removes tag associations when an existing post becomes a page", async function () {
    const entry = {
      id: "work-entry",
      blogID: this.blog.id,
      path: "/work/entry",
      tags: ["automotive", "featured"],
      dateStamp: 1,
    };

    await set(this.blog.id, entry);

    entry.page = true;
    await set(this.blog.id, entry);

    const automotive = await get(this.blog.id, "automotive");
    expect(automotive.entryIDs).toEqual([]);

    const featured = await get(this.blog.id, "featured");
    expect(featured.entryIDs).toEqual([]);
  });
});
