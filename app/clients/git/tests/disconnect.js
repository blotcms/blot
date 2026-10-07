describe("git client disconnect", function () {
  // Sets up a clean test blog (this.blog) for each test,
  // sets the blog's client to git (this.client), then creates
  // a test server with the git client's routes exposed, then
  // cleans everything up when each test has finished.
  require("./setup")({
    clone: false,
  });

  var fs = require("fs-extra");
  var Blog = require("models/blog");
  var database = require("clients/git/database");
  var dataDir = require("clients/git/dataDir");
  var disconnect = require("clients/git/disconnect");
  var promisify = require("util").promisify;
  var randomString = require("../../../../scripts/tests/util/randomString");

  var getToken = promisify(database.getToken);
  var setBlog = promisify(Blog.set);
  var disconnectBlog = promisify(disconnect);

  var otherBlog;

  afterEach(async function () {
    if (!otherBlog) return;

    await fs.remove(dataDir + "/" + otherBlog.handle + ".git");
    await promisify(Blog.remove)(otherBlog.id);
    otherBlog = null;
  });

  // The git token is account-wide, so a second site on the same account
  // is created and connected to git alongside this.blog.
  async function connectSecondBlog(context) {
    otherBlog = await promisify(Blog.create)(context.user.uid, {
      handle: randomString(16),
    });

    await setBlog(otherBlog.id, { client: "git" });
    await setBlog(context.blog.id, { client: "git" });
  }

  it("keeps the token when the owner has another site using git", async function () {
    await connectSecondBlog(this);

    var token = await getToken(this.blog.owner);
    expect(token).toEqual(jasmine.any(String));

    await disconnectBlog(this.blog.id);

    expect(await getToken(this.blog.owner)).toEqual(token);
  });

  it("flushes the token when the last site using git disconnects", async function () {
    await connectSecondBlog(this);

    var token = await getToken(this.blog.owner);
    expect(token).toEqual(jasmine.any(String));

    await disconnectBlog(this.blog.id);
    expect(await getToken(this.blog.owner)).toEqual(token);

    await disconnectBlog(otherBlog.id);

    expect(await getToken(this.blog.owner)).toBe(null);
  });
});
