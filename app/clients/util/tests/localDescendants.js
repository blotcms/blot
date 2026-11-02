describe("clients/util localDescendants", function () {
  const fs = require("fs-extra");
  const { join } = require("path");
  const localDescendants = require("../localDescendants");

  global.test.blog();

  it("lists everything inside a folder as blog paths, parents first", async function () {
    await fs.outputFile(join(this.blogDirectory, "Folder", "a.txt"), "a");
    await fs.outputFile(join(this.blogDirectory, "Folder", "sub", "b.txt"), "b");
    await fs.ensureDir(join(this.blogDirectory, "Folder", "empty"));

    const paths = await localDescendants(this.blog.id, "/Folder");

    expect(paths.sort()).toEqual(
      ["/Folder/a.txt", "/Folder/empty", "/Folder/sub", "/Folder/sub/b.txt"].sort()
    );
    expect(paths.indexOf("/Folder/sub")).toBeLessThan(
      paths.indexOf("/Folder/sub/b.txt")
    );
  });

  it("is empty for a file or a missing path", async function () {
    await fs.outputFile(join(this.blogDirectory, "a.txt"), "a");

    expect(await localDescendants(this.blog.id, "/a.txt")).toEqual([]);
    expect(await localDescendants(this.blog.id, "/missing")).toEqual([]);
  });
});
