describe("clients/util localDescendants", function () {
  const folder = require("storage/folder");
  const localDescendants = require("../localDescendants");

  global.test.blog();

  it("lists everything inside a folder as blog paths, parents first", async function () {
    await test.folder.writeFiles(this.blog.id, {
      "/Folder/a.txt": "a",
      "/Folder/sub/b.txt": "b",
    });
    await folder.mkdir(this.blog.id, "/Folder/empty");

    const paths = await localDescendants(this.blog.id, "/Folder");

    expect(paths.sort()).toEqual(
      ["/Folder/a.txt", "/Folder/empty", "/Folder/sub", "/Folder/sub/b.txt"].sort()
    );
    expect(paths.indexOf("/Folder/sub")).toBeLessThan(
      paths.indexOf("/Folder/sub/b.txt")
    );
  });

  it("is empty for a file or a missing path", async function () {
    await folder.write(this.blog.id, "/a.txt", "a");

    expect(await localDescendants(this.blog.id, "/a.txt")).toEqual([]);
    expect(await localDescendants(this.blog.id, "/missing")).toEqual([]);
  });
});
