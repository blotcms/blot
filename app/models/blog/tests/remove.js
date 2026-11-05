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
    var fs = require("fs-extra");
    var localPath = (blogID, path) => require("path").join(require("config").blog_folder_dir, blogID, path);
    var folder = localPath(test.blog.id, "/");
    var other = localPath(test.blog.id + "0", "/");

    fs.outputFileSync(folder + "/posts/a.txt", "Hello");
    fs.outputFileSync(other + "/b.txt", "Other");

    remove(test.blog.id, function (err) {
      var otherExists = fs.existsSync(other + "/b.txt");

      fs.removeSync(other);

      if (err) return done.fail(err);

      expect(fs.existsSync(folder)).toBe(false);
      expect(otherExists).toBe(true);
      done();
    });
  });

  it("removes a blog which has no folder", function (done) {
    var test = this;

    require("fs-extra").removeSync(
      require("path").join(require("config").blog_folder_dir, test.blog.id)
    );

    remove(test.blog.id, done);
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
});
