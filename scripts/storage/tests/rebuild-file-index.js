describe("scripts/storage/rebuild-file-index", function () {
  var folder = require("storage/folder");
  var File = require("models/file");
  var { rebuild, count } = require("../rebuild-file-index");

  global.test.blog();

  it("counts what the index would hold without changing it", async function () {
    await folder.write(this.blog.id, "/a.txt", "a");
    await folder.write(this.blog.id, "/posts/b.md", "# B");

    var counts = await count(this.blog.id, { hash: false });

    expect(counts.files).toEqual(2);
    expect(counts.dirs).toEqual(1);
    expect(counts.bytes).toEqual(4);
    expect(counts.skipped).toEqual([]);
  });

  it("rebuilds a lost index from the bucket", async function () {
    await folder.write(this.blog.id, "/a.txt", "a");
    await folder.write(this.blog.id, "/posts/b.md", "# B");
    var before = await folder.stat(this.blog.id, "/posts/b.md", { sha1: true });

    await File.removeAll(this.blog.id);
    expect(await folder.exists(this.blog.id, "/a.txt")).toBe(false);

    var result = await rebuild(this.blog.id, { hash: true });

    expect(result.files).toEqual(2);
    expect(await folder.exists(this.blog.id, "/a.txt")).toBe(true);
    expect((await folder.read(this.blog.id, "/posts/b.md")).toString()).toEqual(
      "# B"
    );
    expect(
      (await folder.stat(this.blog.id, "/posts/b.md", { sha1: true })).sha1
    ).toEqual(before.sha1);
  });
});
