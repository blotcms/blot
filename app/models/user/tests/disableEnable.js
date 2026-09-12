var promisify = require("util").promisify;
var User = require("../index");
var Blog = require("models/blog");
var client = require("models/client");
var key = require("../key");
var blogKey = require("models/blog/key");

var getUser = promisify(User.getById);
var setUser = promisify(User.set);
var disable = promisify(User.disable);
var enable = promisify(User.enable);
var getBlog = promisify(Blog.get);
var createBlog = promisify(Blog.create);
var removeBlog = promisify(Blog.remove);

describe("user disable", function () {
  global.test.user();

  it("sets isDisabled to true on user", async function () {
    var user = await getUser(this.user.uid);
    expect(user.isDisabled).toBe(false);

    await disable(user);

    var updated = await getUser(this.user.uid);
    expect(updated.isDisabled).toBe(true);
  });

  it("accepts additional updates", async function () {
    var user = await getUser(this.user.uid);
    await disable(user, { lastSession: "disabled-session" });

    var updated = await getUser(this.user.uid);
    expect(updated.isDisabled).toBe(true);
    expect(updated.lastSession).toEqual("disabled-session");
  });

  it("works with callback signature without updates", function (done) {
    var context = this;
    getUser(context.user.uid, function (err, user) {
      if (err) return done.fail(err);
      User.disable(user, function (err) {
        if (err) return done.fail(err);
        getUser(context.user.uid, function (err, updated) {
          if (err) return done.fail(err);
          expect(updated.isDisabled).toBe(true);
          done();
        });
      });
    });
  });
});

describe("user enable", function () {
  global.test.user();

  beforeEach(async function () {
    var user = await getUser(this.user.uid);
    await disable(user);
  });

  it("sets isDisabled to false on user", async function () {
    var user = await getUser(this.user.uid);
    expect(user.isDisabled).toBe(true);

    await enable(user);

    var updated = await getUser(this.user.uid);
    expect(updated.isDisabled).toBe(false);
  });

  it("accepts additional updates", async function () {
    var user = await getUser(this.user.uid);
    await enable(user, { lastSession: "enabled-session" });

    var updated = await getUser(this.user.uid);
    expect(updated.isDisabled).toBe(false);
    expect(updated.lastSession).toEqual("enabled-session");
  });

  it("works with callback signature without updates", function (done) {
    var context = this;
    getUser(context.user.uid, function (err, user) {
      if (err) return done.fail(err);
      User.enable(user, function (err) {
        if (err) return done.fail(err);
        getUser(context.user.uid, function (err, updated) {
          if (err) return done.fail(err);
          expect(updated.isDisabled).toBe(false);
          done();
        });
      });
    });
  });
});

describe("user disable/enable with blogs", function () {
  global.test.blogs(2);

  it("disable propagates isDisabled to all blogs", async function () {
    var blogIds = this.blogs.map(function (blog) { return blog.id; });
    var user = await getUser(this.user.uid);
    user.blogs = blogIds;
    await setUser(user.uid, { blogs: blogIds });
    user = await getUser(this.user.uid);

    await disable(user);

    for (var i = 0; i < blogIds.length; i++) {
      var blog = await getBlog({ id: blogIds[i] });
      expect(blog.isDisabled).toBe(true);
    }

    var updatedUser = await getUser(this.user.uid);
    expect(updatedUser.isDisabled).toBe(true);
  });

  it("enable propagates isDisabled=false to all blogs", async function () {
    var blogIds = this.blogs.map(function (blog) { return blog.id; });
    var user = await getUser(this.user.uid);
    user.blogs = blogIds;
    await setUser(user.uid, { blogs: blogIds });
    user = await getUser(this.user.uid);

    await disable(user);
    user = await getUser(this.user.uid);
    await enable(user);

    for (var i = 0; i < blogIds.length; i++) {
      var blog = await getBlog({ id: blogIds[i] });
      expect(blog.isDisabled).toBe(false);
    }

    var updatedUser = await getUser(this.user.uid);
    expect(updatedUser.isDisabled).toBe(false);
  });
});
