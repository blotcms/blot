describe("scripts/storage/flag-placeholders", function () {
  var folder = require("storage/folder");
  var {
    unflaggedEmpty,
    incompleteReason,
    SKIPPED,
  } = require("../flag-placeholders");

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

  it("only trusts a resync which revisited every file", function () {
    expect(incompleteReason({ failed: 0 })).toBeNull();
    expect(
      incompleteReason({ failed: 1, firstError: "macserver down" })
    ).toEqual("1 file failed (macserver down)");
    expect(incompleteReason(false)).toContain("did not finish");
    expect(incompleteReason(undefined)).toContain("did not finish");
    expect(incompleteReason(SKIPPED)).toContain("setup");
  });
});
