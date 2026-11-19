describe("wikilinks byFilename: which folder wins", function () {
  const folder = require("storage/folder");
  const Entry = require("models/entry");
  const byFilename = require("build/plugins/wikilinks/byFilename");

  // Directories and what each lists, in the order given; a name ending in /
  // is a folder
  let tree;

  beforeEach(function () {
    spyOn(folder, "listNames").and.callFake(async (blogID, dir) =>
      (tree[dir] || []).map((name) =>
        name.endsWith("/")
          ? { name: name.slice(0, -1), isDirectory: true }
          : { name, isDirectory: false }
      )
    );
    spyOn(folder, "resolveCaseInsensitive").and.callFake(
      async (blogID, path) => {
        const dir = path.slice(0, path.lastIndexOf("/")) || "/";
        const name = path.slice(path.lastIndexOf("/") + 1);

        if ((tree[dir] || []).includes(name)) return path;
        throw new folder.NotFoundError();
      }
    );
    spyOn(folder, "stat").and.callFake(async () => ({ isDirectory: false }));
    spyOn(Entry, "get").and.callFake(async () => undefined);
  });

  // Folders are searched in code-unit order of name, so the result can't
  // depend on the order the folder index lists them in
  it("searches subfolders in code-unit order, whatever the listing order", async function () {
    for (const root of [
      ["alpha/", "Zeta/", "post.md"],
      ["Zeta/", "alpha/", "post.md"],
    ]) {
      tree = {
        "/": root,
        "/alpha": ["target.jpg"],
        "/Zeta": ["target.jpg"],
      };

      const found = await byFilename("blog", "/post.md", "target.jpg");

      expect(found.path).toBe("/Zeta/target.jpg");
    }
  });

  it("still prefers the post's own folder", async function () {
    tree = {
      "/": ["alpha/", "Zeta/", "post.md", "target.jpg"],
      "/alpha": ["target.jpg"],
    };

    const found = await byFilename("blog", "/post.md", "target.jpg");

    expect(found.path).toBe("/target.jpg");
  });
});
