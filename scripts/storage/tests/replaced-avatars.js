describe("scripts/storage/replaced-avatars", function () {
  var Blog = require("models/blog");
  var assets = require("storage/assets");
  var { removeReplaced } = require("../replaced-avatars");

  global.test.blog();

  var DAY = 24 * 60 * 60 * 1000;

  async function names(blogID) {
    return (await assets.list(blogID, "_avatars")).sort();
  }

  beforeEach(async function () {
    var blogID = this.blog.id;

    await assets.write(blogID, "_avatars/old.png", "old");
    await assets.write(blogID, "_avatars/current.png", "current");
    await assets.write(blogID, "_thumbnails/other.png", "other");
    await Blog.set(blogID, {
      avatar: assets.url(blogID, "_avatars/current.png"),
    });
  });

  it("reports without deleting, and deletes only the replaced ones with apply", async function () {
    var blogID = this.blog.id;
    var later = Date.now() + 2 * DAY;

    expect(await removeReplaced(blogID, false, later)).toEqual({
      count: 1,
      bytes: 3,
      kept: 0,
    });
    expect(await names(blogID)).toEqual(["current.png", "old.png"]);

    expect(await removeReplaced(blogID, true, later)).toEqual({
      count: 1,
      bytes: 3,
      kept: 0,
    });
    expect(await names(blogID)).toEqual(["current.png"]);
    expect(await assets.exists(blogID, "_thumbnails/other.png")).toBe(true);
  });

  it("keeps files less than a day old", async function () {
    var blogID = this.blog.id;

    expect(await removeReplaced(blogID, true)).toEqual({
      count: 0,
      bytes: 0,
      kept: 1,
    });
    expect(await names(blogID)).toEqual(["current.png", "old.png"]);
  });

  it("skips a blog whose avatar is not under _avatars", async function () {
    var blogID = this.blog.id;

    await Blog.set(blogID, { avatar: "https://example.com/me.png" });

    expect(await removeReplaced(blogID, true, Date.now() + 2 * DAY)).toEqual({
      skipped: true,
    });
    expect(await names(blogID)).toEqual(["current.png", "old.png"]);
  });
});
