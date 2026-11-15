describe("scripts/storage/remove-file-index-names", function () {
  var File = require("models/file");
  var client = require("models/client");
  var { removeNames } = require("../remove-file-index-names");

  global.test.blog();

  var FILE = { type: "file", size: 1, modified: 1700000000000, sha1: "" };

  // Names sets as code from before this one left them
  async function leave(blogID, dirs) {
    for (var dir of dirs)
      await client.zAdd(File.key.names(blogID, dir), { score: 0, value: "x" });
  }

  it("counts the names sets without apply, deletes them with it, and leaves the rest", async function () {
    await File.setMany(this.blog.id, [
      Object.assign({ path: "/a" }, FILE),
      Object.assign({ path: "/d/e/f" }, FILE),
    ]);
    await leave(this.blog.id, ["/", "/d", "/d/e"]);

    expect(await removeNames(this.blog.id, false)).toEqual(3);
    expect(await client.exists(File.key.names(this.blog.id, "/d"))).toBe(1);

    expect(await removeNames(this.blog.id, true)).toEqual(3);
    expect(await removeNames(this.blog.id, false)).toEqual(0);

    expect(await File.get(this.blog.id, "/d/e/f")).toEqual(FILE);
    expect(
      (await File.listAll(this.blog.id, "/")).map((entry) => entry.name)
    ).toEqual(["a", "d"]);
  });
});
