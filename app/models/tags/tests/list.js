describe("tags.list", function () {
  const { promisify } = require("util");
  const set = promisify(require("../set"));
  const list = require("../list");

  // Create a test user and blog before each spec
  global.test.blog();

  it("can be invoked without error", async function () {
    const blogID = this.blog.id;
    const entry1 = {
      id: "entry1",
      path: "/entry1",
      tags: ["tag1", "tag2"],
    };

    const entry2 = {
      id: "entry2",
      path: "/entry2",
      tags: ["tag2", "tag3"],
    };

    await set(blogID, entry1);
    await set(blogID, entry2);

    const tags = await list(blogID);

    const sortedTags = tags
      .sort((a, b) => a.slug.localeCompare(b.slug))
      .map((tag) => {
        return {
          name: tag.name,
          slug: tag.slug,
          entries: tag.entries.sort(),
        };
      });

    // tags.list now returns entry placeholders with null values
    // the important property is the entries array length
    expect(sortedTags).toEqual([
      { name: "tag1", slug: "tag1", entries: [null] },
      { name: "tag2", slug: "tag2", entries: [null, null] },
      { name: "tag3", slug: "tag3", entries: [null] },
    ]);
  });

  it("filters tags by pathPrefix", async function () {
    const blogID = this.blog.id;

    await set(blogID, {
      id: "/Blog/one",
      path: "/Blog/one",
      tags: ["TagA", "TagB"],
    });
    await set(blogID, {
      id: "/Blog/two",
      path: "/Blog/two",
      tags: ["TagA"],
    });
    await set(blogID, {
      id: "/notes/one",
      path: "/notes/one",
      tags: ["TagB", "TagC"],
    });

    const tags = await list(blogID, { pathPrefix: "  Blog/ " });

    const sortedTags = tags
      .sort((a, b) => a.slug.localeCompare(b.slug))
      .map((tag) => ({
        slug: tag.slug,
        entries: tag.entries.slice().sort(),
      }));

    expect(sortedTags).toEqual([
      { slug: "taga", entries: ["/Blog/one", "/Blog/two"] },
      { slug: "tagb", entries: ["/Blog/one"] },
    ]);
  });

  it("does not call zcard when filtering by pathPrefix", async function () {
    const blogID = this.blog.id;
    const client = require("models/client");

    await set(blogID, {
      id: "/Blog/one",
      path: "/Blog/one",
      tags: ["TagA"],
    });

    spyOn(client, "zCard").and.callThrough();

    const tags = await list(blogID, { pathPrefix: "Blog" });

    expect(tags).toEqual([
      {
        name: "TagA",
        slug: "taga",
        entries: ["/Blog/one"],
      },
    ]);
    expect(client.zCard).not.toHaveBeenCalled();
  });
});

describe("tags.list without a callback", function () {
  const { promisify } = require("util");
  const set = promisify(require("../set"));
  const list = require("../list");
  const popular = require("../popular");

  global.test.blog();

  it("returns a promise", async function () {
    const blogID = this.blog.id;
    await set(blogID, { id: "p1", path: "/p1", tags: ["tag1"] });

    const tags = await list(blogID);
    expect(tags.map((tag) => tag.slug)).toEqual(["tag1"]);
    expect(await popular(blogID)).toEqual([
      jasmine.objectContaining({ slug: "tag1", count: 1 }),
    ]);
  });

  it("rejects on a bad blog ID", async function () {
    await expectAsync(list(123)).toBeRejected();
    await expectAsync(popular(123)).toBeRejected();
  });
});
