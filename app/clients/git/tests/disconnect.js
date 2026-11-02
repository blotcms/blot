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
  var repo = require("clients/git/repo");
  var disconnect = require("clients/git/disconnect");
  var promisify = require("util").promisify;
  var randomString = require("../../../../scripts/tests/util/randomString");

  var getToken = promisify(database.getToken);
  var setBlog = promisify(Blog.set);
  var disconnectBlog = promisify(disconnect);

  var otherBlog;

  afterEach(async function () {
    if (!otherBlog) return;

    await fs.remove(repo.directory(otherBlog.handle));
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
    await require("./setup/liveClone")(this);

    expect(await fs.pathExists(repo.directory(this.blog.handle))).toBe(true);
    expect(await fs.pathExists(this.blogDirectory + "/.git")).toBe(true);

    await disconnectBlog(this.blog.id);

    expect(await fs.pathExists(repo.directory(this.blog.handle))).toBe(false);
    expect(await fs.pathExists(this.blogDirectory + "/.git")).toBe(false);
    expect((await promisify(Blog.get)({ id: this.blog.id })).client).toBe("");
  });

  it("removes the repository of a blog which has no live clone", async function () {
    expect(await fs.pathExists(this.blogDirectory + "/.git")).toBe(false);

    await disconnectBlog(this.blog.id);

    expect(await fs.pathExists(repo.directory(this.blog.handle))).toBe(false);
  });

  it("removes the repository even if the blog folder is already gone", async function () {
    await fs.remove(this.blogDirectory);

    await disconnectBlog(this.blog.id);

    expect(await fs.pathExists(repo.directory(this.blog.handle))).toBe(false);
  });

  it("leaves a repository at a handle the blog no longer has", async function () {
    var oldHandle = this.blog.handle;

    await setBlog(this.blog.id, { handle: randomString(16) });

    var latest = await promisify(Blog.get)({ id: this.blog.id });

    // A repository left at the former handle, as a failed rename leaves one
    await fs.outputFile(repo.directory(oldHandle) + "/left-behind", "Not this blog's now");

    await disconnectBlog(this.blog.id);

    expect(await fs.pathExists(repo.directory(latest.handle))).toBe(false);
    expect(await fs.pathExists(repo.directory(oldHandle) + "/left-behind")).toBe(true);

    await fs.remove(repo.directory(oldHandle));
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
    var createRepo = promisify(require("clients/git/create"));
    var removeBlog = promisify(Blog.remove);
    var getBlog = promisify(Blog.get);

    async function connectedBlog(context) {
      otherBlog = await promisify(Blog.create)(context.user.uid, {
        handle: randomString(16),
      });

      await setBlog(otherBlog.id, { client: "git" });
      await createRepo(await getBlog({ id: otherBlog.id }));

      expect(await fs.pathExists(repo.directory(otherBlog.handle))).toBe(true);

      return otherBlog;
    }

    it("removes its repository", async function () {
      var blog = await connectedBlog(this);

      otherBlog = null;
      await removeBlog(blog.id);

      expect(await fs.pathExists(repo.directory(blog.handle))).toBe(false);
    });

    it("removes its repository even if its folder is already gone", async function () {
      var blog = await connectedBlog(this);

      await fs.remove(require("path").join(require("config").blog_folder_dir, blog.id));

      otherBlog = null;
      await removeBlog(blog.id);

      expect(await fs.pathExists(repo.directory(blog.handle))).toBe(false);
    });
  });
});
