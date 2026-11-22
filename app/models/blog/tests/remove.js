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

  describe("templates", function () {
    var client = require("models/client");
    var Template = require("models/template");
    var templateKey = require("models/template/key");

    async function createTemplate(blogID, name, hash) {
      var template = await Template.create(blogID, name, {});
      await client.hSet(
        templateKey.metadata(template.id),
        "cdn",
        JSON.stringify({ "style.css": hash })
      );
      await client.set(templateKey.renderedOutput(hash), "rendered");
      return template;
    }

    it("drops the blog's templates: their rendered outputs go and their purges are queued", async function () {
      var purge = spyOn(require("cdn/purgeQueue"), "add").and.callThrough();
      var hash = "a1b2c3d4e5f6a7b8";

      await createTemplate(this.blog.id, "mine", hash);
      expect(await client.get(templateKey.renderedOutput(hash))).toEqual(
        "rendered"
      );

      await remove(this.blog.id);

      expect(await client.get(templateKey.renderedOutput(hash))).toBeNull();
      expect(
        purge.calls.allArgs().some(function (args) {
          return args[0].length > 0;
        })
      ).toBe(true);
    });

    it("still removes the blog when a template fails to drop", async function () {
      var logged = spyOn(console, "error");
      var calls = 0;

      await createTemplate(this.blog.id, "first", "c1d2e3f4a5b6c7d8");
      await createTemplate(this.blog.id, "second", "d1e2f3a4b5c6d7e8");

      var count = (
        await client.sMembers(templateKey.blogTemplates(this.blog.id))
      ).length;

      // Template.drop's last step; the first template's drop throws
      spyOn(
        require("models/template/util/cacheID"),
        "bumpBlogIfInstalled"
      ).and.callFake(async function () {
        calls++;
        if (calls === 1) throw new Error("drop failed");
      });

      await remove(this.blog.id);

      // The blog's own templates too, not only the two above
      expect(calls).toEqual(count);
      expect(count).toBeGreaterThan(1);
      expect(logged).toHaveBeenCalled();
      expect(await getAllIDs()).not.toContain(this.blog.id);
      expect(await redisSearch(this.blog.id)).toEqual([]);
    });
  });

  describe("when interrupted", function () {
    var client = require("models/client");
    var key = require("../key");
    var Blog = require("../index");
    var User = require("models/user");
    var discover = require("models/discover");

    // Fails the step after the user is updated, as a kill there would
    function interrupt() {
      return spyOn(discover, "removeBlog").and.callFake(() =>
        Promise.reject(new Error("killed"))
      );
    }

    afterEach(async function () {
      await client.zRem(key.removing, this.blog.id);
      await client.hDel(key.removalAttempts, this.blog.id);
    });

    it("records the blog while it is being removed and drops it at the end", async function () {
      interrupt();

      await expectAsync(remove(this.blog.id)).toBeRejected();

      expect(await client.zScore(key.removing, this.blog.id)).toBeGreaterThan(
        Date.now()
      );

      discover.removeBlog.and.callThrough();
      await remove(this.blog.id);

      expect(await client.zScore(key.removing, this.blog.id)).toBeNull();
    });

    it("stops the site serving while the removal is unfinished", async function () {
      interrupt();

      await expectAsync(remove(this.blog.id)).toBeRejected();

      var blog = await Blog.get({ id: this.blog.id });

      expect(blog.isDisabled).toBe(true);
      expect((await User.getById(this.user.uid)).blogs).not.toContain(blog.id);
    });

    it("finishes a blog the owner no longer lists and discover has dropped", async function () {
      var folder = require("storage/folder");

      await folder.write(this.blog.id, "/a.txt", "Hello");
      interrupt();
      await expectAsync(remove(this.blog.id)).toBeRejected();

      discover.removeBlog.and.callThrough();
      await remove(this.blog.id);
      await remove(this.blog.id).then(
        function () {
          throw new Error("Expected the finished blog to be gone");
        },
        function (err) {
          expect(err.message).toEqual("No blog");
        }
      );

      expect(await folder.exists(this.blog.id, "/a.txt")).toBe(false);
      expect(await redisSearch(this.blog.id)).toEqual([]);
    });

    it("finishes a removal whose blog record is already deleted", async function () {
      var purgeQueue = require("cdn/purgeQueue");
      var purge = spyOn(purgeQueue, "blog").and.callFake(() =>
        Promise.reject(new Error("killed"))
      );

      await expectAsync(remove(this.blog.id)).toBeRejected();

      expect(await Blog.get({ id: this.blog.id })).toBeUndefined();
      expect(await client.zScore(key.removing, this.blog.id)).not.toBeNull();

      purge.and.returnValue(Promise.resolve());
      await remove(this.blog.id);

      expect(purge).toHaveBeenCalledTimes(2);
      expect(await redisSearch(this.blog.id)).toEqual([]);
    });
  });

  it("returns a promise without a callback", async function () {
    var removed = await remove(this.blog.id);

    expect(removed.id).toEqual(this.blog.id);
    expect(await getAllIDs()).not.toContain(this.blog.id);
  });
});
