describe("Blog.remove", function () {
  var create = require("../create");
  var remove = require("../remove");
  var getAllIDs = require("../getAllIDs");
  var redisSearch = require("helper/redisSearch");

  // Create a test user and blog before each spec
  global.test.user();

  beforeEach(async function () {
    this.blog = await create(this.user.uid, { handle: "exampleblog" });
    if (!this.blog) throw new Error("No blog");
  });

  it("removes a blog", function (done) {
    var test = this;

    remove(test.blog.id, done);
  });

  it("removes a blog", async function () {
    await remove(this.blog.id);

    const results = await redisSearch(this.blog.id);

    expect(results).toEqual([]);
  });

  it("removes the blog's folder and nothing beside it", async function () {
    var folder = require("storage/folder");
    var otherID = this.blog.id + "0";

    await Promise.all([
      folder.write(this.blog.id, "/posts/a.txt", "Hello"),
      folder.write(otherID, "/b.txt", "Other"),
    ]);

    await remove(this.blog.id);

    const found = await Promise.all([
      folder.exists(this.blog.id, "/posts/a.txt"),
      folder.listNames(this.blog.id, "/").catch(function () {
        return [];
      }),
      folder.exists(otherID, "/b.txt"),
    ]);

    await folder.removeAll(otherID);

    expect(found[0]).toBe(false);
    expect(found[1]).toEqual([]);
    expect(found[2]).toBe(true);
  });

  it("removes a blog which has no folder", async function () {
    await require("storage/folder").removeAll(this.blog.id);
    await remove(this.blog.id);
  });

  it("removes a blog from list of all blogs", async function () {
    const blog = await remove(this.blog.id);

    expect(await getAllIDs()).not.toContain(blog.id);
  });

  it("leaves the folder lock to a sync which still holds it", async function () {
    var folderLock = require("sync/lock");
    var blogID = this.blog.id;
    var lost = jasmine.createSpy("onCompromised");
    var held = await folderLock.lock(blogID, { onCompromised: lost });

    await remove(blogID);

    expect((await folderLock.inspect(blogID)).held).toBe(true);

    await held.release();

    expect(lost).not.toHaveBeenCalled();
    expect((await folderLock.inspect(blogID)).held).toBe(false);
  });

  it("returns a promise without a callback", async function () {
    var removed = await remove(this.blog.id);

    expect(removed.id).toEqual(this.blog.id);
    expect(await getAllIDs()).not.toContain(this.blog.id);
  });
});
