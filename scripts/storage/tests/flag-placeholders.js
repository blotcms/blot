describe("scripts/storage/flag-placeholders", function () {
  var folder = require("storage/folder");
  var { unflaggedEmpty } = require("../flag-placeholders");

  global.test.blog();

  it("finds the empty files which have no flag", async function () {
    await folder.write(this.blog.id, "/a.txt", "a");
    await folder.write(this.blog.id, "/empty.txt", "");
    await folder.write(this.blog.id, "/posts/old-placeholder.pdf", "");
    await folder.writePlaceholder(this.blog.id, "/posts/big.mov", {
      code: "SYNC_TOO_LARGE",
      size: 200,
      limit: 100,
    });

    expect((await unflaggedEmpty(this.blog.id)).sort()).toEqual([
      "/empty.txt",
      "/posts/old-placeholder.pdf",
    ]);
  });
});
