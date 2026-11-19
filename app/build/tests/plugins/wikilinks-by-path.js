describe("wikilinks byPath: extensionless links", function () {
  const folder = require("storage/folder");
  const { searchForExtension } = require("build/plugins/wikilinks/byPath");

  let listing;

  beforeEach(function () {
    spyOn(folder, "resolveCaseInsensitive").and.callFake(async () => "/Posts");
    spyOn(folder, "listNames").and.callFake(async () => listing);
  });

  // Resolve "/Posts/<base>" against a directory which lists these names,
  // in the order given and then reversed. Both must give the same answer.
  // A name ending in / is a folder.
  async function resolve(names, base) {
    listing = names.map((name) =>
      name.endsWith("/")
        ? { name: name.slice(0, -1), isDirectory: true }
        : { name, isDirectory: false }
    );
    const forward = await searchForExtension("blog", "/Posts/" + base);

    listing = [...listing].reverse();
    const backward = await searchForExtension("blog", "/Posts/" + base);

    expect(backward).toEqual(forward);
    return forward;
  }

  it("prefers post.md to post-two.md in either listing order", async function () {
    expect(await resolve(["post-two.md", "post.md"], "post")).toBe(
      "/Posts/post.md"
    );
  });

  it("ignores a folder with the link's name", async function () {
    expect(await resolve(["post/", "post.md"], "post")).toBe("/Posts/post.md");
  });

  it("prefers an exact match to a normalized one", async function () {
    expect(await resolve(["My Post.md", "my-post.md"], "my-post")).toBe(
      "/Posts/my-post.md"
    );
  });

  it("falls back to a normalized match, then to the shortest prefix", async function () {
    expect(await resolve(["My Post.md", "other.md"], "my-post")).toBe(
      "/Posts/My Post.md"
    );
  });

  it("still resolves by prefix, choosing the shortest name", async function () {
    expect(await resolve(["post-two.md", "post-a.md", "x.md"], "post")).toBe(
      "/Posts/post-a.md"
    );
    expect(await resolve(["2024-01-01-post.md", "x.md"], "2024-01-01")).toBe(
      "/Posts/2024-01-01-post.md"
    );
  });

  it("breaks a tie between extensions the same way every time", async function () {
    expect(await resolve(["post.txt", "post.md"], "post")).toBe(
      "/Posts/post.md"
    );
  });

  it("matches nothing when no name starts with the link", async function () {
    await expectAsync(resolve(["other.md"], "post")).toBeRejected();
  });
});
