var User = require("../index");
var Blog = require("models/blog");
require("models/client");

var getUser = User.getById;
var setUser = User.set;
var disable = User.disable;
var enable = User.enable;
var getBlog = Blog.get;

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

  it("works without updates argument", async function () {
    var user = await getUser(this.user.uid);
    await disable(user);

    var updated = await getUser(this.user.uid);
    expect(updated.isDisabled).toBe(true);
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

  it("works without updates argument", async function () {
    var user = await getUser(this.user.uid);
    await enable(user);

    var updated = await getUser(this.user.uid);
    expect(updated.isDisabled).toBe(false);
  });
});

describe("user disable/enable with blogs", function () {
  global.test.blogs(2);

  it("disable propagates isDisabled to all blogs", async function () {
    var blogIds = this.blogs.map(function (blog) {
      return blog.id;
    });
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
    var blogIds = this.blogs.map(function (blog) {
      return blog.id;
    });
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
