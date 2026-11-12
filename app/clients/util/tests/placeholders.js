describe("clients/util/placeholders", function () {
  var storage = require("storage/folder");
  var placeholders = require("../placeholders");

  global.test.blog();

  var TOO_LARGE = { code: "SYNC_TOO_LARGE", size: 200, limit: 100 };

  beforeEach(async function () {
    await storage.writePlaceholder(this.blog.id, "/big.mov", TOO_LARGE);
    await storage.writePlaceholder(this.blog.id, "/notes/plan.paper", {
      code: "SYNC_UNSUPPORTED",
      kind: ".paper",
    });
    await storage.write(this.blog.id, "/empty.txt", "");
    await storage.write(this.blog.id, "/post.md", "# Hi");
  });

  it("lists the folder's placeholders and why each was written", async function () {
    var found = await placeholders.list(this.blog.id);

    found.sort(function (a, b) {
      return a.path < b.path ? -1 : 1;
    });

    expect(found).toEqual([
      { path: "/big.mov", flags: [TOO_LARGE] },
      {
        path: "/notes/plan.paper",
        flags: [{ code: "SYNC_UNSUPPORTED", kind: ".paper" }],
      },
    ]);
  });

  it("removes only placeholders, and syncs each removal", async function () {
    var folder = {
      status: function () {},
      update: jasmine.createSpy("update").and.returnValue(Promise.resolve()),
    };

    var removed = await placeholders.remove(this.blog.id, folder);

    expect(removed.sort()).toEqual(["/big.mov", "/notes/plan.paper"]);
    expect(
      folder.update.calls.allArgs().map(function (args) {
        return args[0];
      })
    ).toEqual(jasmine.arrayWithExactContents(removed));
    expect(await storage.exists(this.blog.id, "/big.mov")).toBe(false);
    expect(await storage.exists(this.blog.id, "/empty.txt")).toBe(true);
    expect(await storage.exists(this.blog.id, "/post.md")).toBe(true);
  });

  it("never fails a disconnect", async function () {
    expect(
      await placeholders.removeAtDisconnect("no-such-blog-for-placeholders")
    ).toEqual([]);
  });
});
