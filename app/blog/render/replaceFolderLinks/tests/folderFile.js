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

  it("does not read a file over the size cap whose index record has no SHA-1", async function () {
    const File = require("models/file");

    await folder.write(this.blog.id, "/images/big.mp4", "x");
    await File.set(this.blog.id, "/images/big.mp4", {
      type: "file",
      size: 6 * 1024 * 1024,
      modified: 1700000000000,
      sha1: "",
    });

    spyOn(folder, "ensureLocal").and.callThrough();
    spyOn(folder, "read").and.callThrough();

    const found = await hashFolderFile(this.blog.id, "/images/big.mp4");

    expect(found.version).toEqual(
      contentVersion.fromFolderRecord({
        size: 6 * 1024 * 1024,
        modified: 1700000000000,
      })
    );
    expect(folder.ensureLocal).not.toHaveBeenCalled();
    expect(folder.read).not.toHaveBeenCalled();
  });

  it("finds a file in another case, and answers null for none", async function () {
    await folder.write(this.blog.id, "/images/B.jpg", "bee");

    expect((await hashFolderFile(this.blog.id, "/images/b.jpg")).path).toBe(
      "/images/B.jpg"
    );
    expect(await hashFolderFile(this.blog.id, "/images/none.jpg")).toBe(null);
  });
});
