describe("replaceFolderLinks folderFile", function () {
  const folder = require("storage/folder");
  const contentVersion = require("helper/contentVersion");
  const { hashFolderFile } = require("../folderFile");

  global.test.blog();

  it("versions a file from its index record, without reading it", async function () {
    await folder.write(this.blog.id, "/images/a.jpg", "hello");
    const expected = await contentVersion.fromFolder(
      this.blog.id,
      "/images/a.jpg",
      await folder.stat(this.blog.id, "/images/a.jpg")
    );

    spyOn(folder, "read").and.callThrough();
    spyOn(folder, "ensureLocal").and.callThrough();

    const found = await hashFolderFile(this.blog.id, "/images/a.jpg");

    expect(found).toEqual({ path: "/images/a.jpg", version: expected });
    expect(folder.read).not.toHaveBeenCalled();
    expect(folder.ensureLocal).not.toHaveBeenCalled();
  });

  it("reads the index once for a file at the exact path", async function () {
    const File = require("models/file");

    await folder.write(this.blog.id, "/images/c.jpg", "see");
    spyOn(File, "get").and.callThrough();

    await hashFolderFile(this.blog.id, "/images/c.jpg");

    expect(File.get).toHaveBeenCalledTimes(1);
  });

  it("finds a file in another case, and answers null for none", async function () {
    await folder.write(this.blog.id, "/images/B.jpg", "bee");

    expect((await hashFolderFile(this.blog.id, "/images/b.jpg")).path).toBe(
      "/images/B.jpg"
    );
    expect(await hashFolderFile(this.blog.id, "/images/none.jpg")).toBe(null);
  });
});
