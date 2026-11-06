describe("Blog.remove", function () {
  var create = require("../create");
  var remove = require("../remove");
  var getAllIDs = require("../getAllIDs");
  var redisSearch = require("helper/redisSearch");

  // Create a test user and blog before each spec
  global.test.user();

  beforeEach(function (done) {
    var test = this;
    create(test.user.uid, { handle: "exampleblog" }, function (err, blog) {
      if (err || !blog) return done.fail(err || new Error("No blog"));
      test.blog = blog;
      done();
    });
  });

  it("removes a blog", function (done) {
    var test = this;

    remove(test.blog.id, done);
  });

  it("removes a blog", function (done) {
    var test = this;

    remove(test.blog.id, function (err) {
      if (err) return done.fail(err);
      redisSearch(test.blog.id, function (err, results) {
        if (err) return done.fail(err);

        expect(results).toEqual([]);
        done();
      });
    });
  });

  it("removes the blog's folder and nothing beside it", function (done) {
    var test = this;
    var folder = require("storage/folder");
    var otherID = test.blog.id + "0";

    Promise.all([
      folder.write(test.blog.id, "/posts/a.txt", "Hello"),
      folder.write(otherID, "/b.txt", "Other"),
    ]).then(function () {
      remove(test.blog.id, function (err) {
        if (err) return done.fail(err);

        Promise.all([
          folder.exists(test.blog.id, "/posts/a.txt"),
          folder.listNames(test.blog.id, "/").catch(function () {
            return [];
          }),
          folder.exists(otherID, "/b.txt"),
        ])
          .then(function (found) {
            return folder.removeAll(otherID).then(function () {
              expect(found[0]).toBe(false);
              expect(found[1]).toEqual([]);
              expect(found[2]).toBe(true);
              done();
            });
          })
          .catch(done.fail);
      });
    }, done.fail);
  });

  it("removes a blog which has no folder", function (done) {
    var test = this;

    require("storage/folder")
      .removeAll(test.blog.id)
      .then(function () {
        remove(test.blog.id, done);
      }, done.fail);
  });

  it("removes a blog from list of all blogs", function (done) {
    var test = this;

    remove(test.blog.id, function (err, blog) {
      if (err) return done.fail(err);

      getAllIDs(function (err, ids) {
        expect(ids).not.toContain(blog.id);
        done();
      });
    });
  });

  it("leaves the folder lock to a sync which still holds it", async function () {
    var folderLock = require("sync/lock");
    var blogID = this.blog.id;
    var lost = jasmine.createSpy("onCompromised");
    var held = await folderLock.lock(blogID, { onCompromised: lost });

    await new Promise(function (resolve, reject) {
      remove(blogID, function (err) {
        if (err) return reject(err);
        resolve();
      });
    });

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
