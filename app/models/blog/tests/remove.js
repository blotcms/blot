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
});
