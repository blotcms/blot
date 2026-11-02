// IMPLEMENTATION-SPECIFIC. Blot's writes (client.write and client.remove) are
// commits in the bare repository, made without a clone (#2259 PR 8). A blog
// made before that still has a live clone in its folder's .git directory until
// PR 9 removes them, and the writes keep it at master, so that this code can be
// rolled back: the previous code commits in the clone and pushes. These specs
// are about that, and about writes in a blog with none. Delete this file with
// the live clones.
describe("git client writes and the live clone (implementation-specific)", function () {
  require("./setup")({ clone: false, client: true });

  var fs = require("fs-extra");
  var util = require("util");
  var write = util.promisify(require("clients/git/write"));
  var remove = util.promisify(require("clients/git/remove"));
  var repo = require("clients/git/repo");
  var Blog = require("models/blog");
  var localPath = (blogID, path) => require("path").join(require("config").blog_folder_dir, blogID, path);
  var liveClone = require("./setup/liveClone");
  var helpers = require("./setup/helpers");

  async function cloneHead(git) {
    return (await git.raw(["rev-parse", "HEAD"])).trim();
  }

  it("makes no live clone for a blog which has none", async function () {
    await write(this.blog.id, "/no clone.txt", "Hello, world!");
    await remove(this.blog.id, "/no clone.txt");
    await write(this.blog.id, "/no clone.txt", "Hello, world!");

    expect(await fs.pathExists(this.blogDirectory + "/.git")).toBe(false);
    expect(await helpers.blogFile(this, "/no clone.txt")).toEqual(Buffer.from("Hello, world!"));
  });

  it("keeps the live clone at master", async function () {
    var git = await liveClone(this);

    await write(this.blog.id, "/one.txt", "One");
    expect(await cloneHead(git)).toBe(await this.local.remoteHead());

    await write(this.blog.id, "/two.txt", "Two");
    expect(await cloneHead(git)).toBe(await this.local.remoteHead());

    await remove(this.blog.id, "/one.txt");
    expect(await cloneHead(git)).toBe(await this.local.remoteHead());
  });

  it("still writes when the live clone is broken", async function () {
    await liveClone(this);

    // Not a repository any more: the write does not care
    await fs.outputFile(this.blogDirectory + "/.git/HEAD", "garbage");

    await write(this.blog.id, "/one.txt", "One");

    expect(await helpers.blogFile(this, "/one.txt")).toEqual(Buffer.from("One"));

    await this.local.pull();

    expect((await this.local.read("/one.txt")).toString()).toBe("One");
  });

  it("fixes a stale origin of the live clone", async function () {
    var git = await liveClone(this);
    var bareDirectory = repo.directory(this.blog.handle);

    await git.raw(["remote", "set-url", "origin", "/nonexistent/x.git"]);
    await write(this.blog.id, "/Stale origin.txt", "Hello, world!");

    expect((await git.raw(["remote", "get-url", "origin"])).trim()).toBe(bareDirectory);
    expect(await cloneHead(git)).toBe(await this.local.remoteHead());

    await git.raw(["remote", "set-url", "origin", "/nonexistent/x.git"]);
    await remove(this.blog.id, "/Stale origin.txt");

    expect((await git.raw(["remote", "get-url", "origin"])).trim()).toBe(bareDirectory);
    expect(await cloneHead(git)).toBe(await this.local.remoteHead());
  });

  it("leaves origin unchanged if the target bare repo does not exist", async function () {
    var git = await liveClone(this);
    var oldURL = "/nonexistent/old-location.git";

    await git.raw(["remote", "set-url", "origin", oldURL]);

    await util.promisify(repo.pointOriginAtBareRepo)(git, "handle-without-a-bare-repo");

    expect((await git.raw(["remote", "get-url", "origin"])).trim()).toBe(oldURL);
  });

  // What the previous code does on the next write after this one is rolled
  // back: it commits in the live clone and pushes, which is refused unless the
  // clone is at master
  it("leaves a live clone which the previous code can commit and push from", async function () {
    var git = await liveClone(this);

    await write(this.blog.id, "/by-blot.txt", "From Blot");
    await this.local.pull();
    await this.local.writeAndPush("/by-the-user.txt", "From the user");
    await write(this.blog.id, "/by-blot-again.txt", "From Blot again");

    await fs.outputFile(this.blogDirectory + "/by-the-old-code.txt", "From the old code");
    await git.raw(["add", "--", "by-the-old-code.txt"]);
    await git.raw([
      "-c", "user.name=Old", "-c", "user.email=old@example.com",
      "commit", "-m", "Updated by-the-old-code.txt",
    ]);
    await git.raw(["push", "origin", "master"]);

    await this.local.pull();

    expect((await this.local.read("/by-the-old-code.txt")).toString()).toBe("From the old code");
    expect((await this.local.read("/by-blot-again.txt")).toString()).toBe("From Blot again");
  });

  it("does not modify the blog folder if the blog lookup fails", async function () {
    var blogID = this.blog.id;
    var path = "/Lookup fails.txt";
    var existingPath = "/Existing file.txt";
    var originalGet = Blog.get;

    // Restored by hand (rather than with a spy) so the setup's
    // afterEach hooks, which also use Blog.get, see the real thing
    function failLookups() {
      Blog.get = function (query, callback) {
        callback(new Error("redis down"));
      };
    }

    function restoreLookups() {
      Blog.get = originalGet;
    }

    // Start with a tracked file, so we can check remove leaves it alone
    await write(blogID, existingPath, "Hello, world!");

    failLookups();

    try {
      await write(blogID, path, "Should not be written");
      fail("write should have failed");
    } catch (err) {
      expect(err.message).toEqual("redis down");
    }

    expect(fs.existsSync(localPath(blogID, path))).toBe(false);

    try {
      await remove(blogID, existingPath);
      fail("remove should have failed");
    } catch (err) {
      expect(err.message).toEqual("redis down");
    } finally {
      restoreLookups();
    }

    expect(fs.readFileSync(localPath(blogID, existingPath), "utf8")).toEqual("Hello, world!");
  });
});
