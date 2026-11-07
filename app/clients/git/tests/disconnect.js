describe("git client disconnect", function () {
  // Sets up a clean test blog (this.blog) for each test, connects it to git
  // with its repository in the git store (a memory store per blog), then
  // creates a test server with the git client's routes exposed, then cleans
  // everything up when each test has finished.
  require("./setup")({
    clone: false,
  });

  var Blog = require("models/blog");
  var database = require("clients/git/database");
  var repo = require("clients/git/repo");
  var folder = require("./setup/folder");
  var disconnect = require("clients/git/disconnect");
  var promisify = require("util").promisify;
  var randomString = require("../../../../scripts/tests/util/randomString");

  var getToken = database.getToken;
  var setBlog = promisify(Blog.set);
  var disconnectBlog = disconnect;
  var inStore = repo.exists;

  var otherBlog;

  afterEach(async function () {
    if (!otherBlog) return;

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

  it("removes the repository, and a live clone in the blog folder", async function () {
    // What blogs from before Blot stopped committing in the blog folder have
    await folder.write(this.blog.id, "/.git/HEAD", "ref: refs/heads/master\n");

    expect(await inStore(this.blog.id)).toBe(true);

    await disconnectBlog(this.blog.id);

    expect(await inStore(this.blog.id)).toBe(false);
    expect(await folder.has(this.blog.id, "/.git")).toBe(false);
    expect((await promisify(Blog.get)({ id: this.blog.id })).client).toBe("");
  });

  it("removes the repository even if the blog folder is already gone", async function () {
    await require("storage/folder").removeAll(this.blog.id);

    await disconnectBlog(this.blog.id);

    expect(await inStore(this.blog.id)).toBe(false);
  });

  it("removes the repository after a change of handle", async function () {
    await setBlog(this.blog.id, { handle: randomString(16) });

    await disconnectBlog(this.blog.id);

    expect(await inStore(this.blog.id)).toBe(false);
  });

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

  describe("when the blog is deleted", function () {
    var createRepo = require("clients/git/create");
    var removeBlog = promisify(Blog.remove);
    var getBlog = promisify(Blog.get);

    async function connectedBlog(context) {
      otherBlog = await promisify(Blog.create)(context.user.uid, {
        handle: randomString(16),
      });

      await setBlog(otherBlog.id, { client: "git" });
      await createRepo(await getBlog({ id: otherBlog.id }));

      expect(await inStore(otherBlog.id)).toBe(true);

      return otherBlog;
    }

    it("removes its repository", async function () {
      var blog = await connectedBlog(this);

      otherBlog = null;
      await removeBlog(blog.id);

      expect(await inStore(blog.id)).toBe(false);
    });

    it("removes its repository even if its folder is already gone", async function () {
      var blog = await connectedBlog(this);

      await require("storage/folder").removeAll(blog.id);

      otherBlog = null;
      await removeBlog(blog.id);

      expect(await inStore(blog.id)).toBe(false);
    });
  });
});
