// The first import of a blog folder into a new repository (create.js) is made
// in the bare repository, with no live clone, and a user can clone it, push
// and have Blot sync the push straight away (#2259 PR 8).
describe("git client create without a live clone", function () {
  require("./setup")({ setClientToGit: false, clone: false });

  var fs = require("fs-extra");
  var util = require("util");
  var childProcess = require("child_process");
  var Client = require("./setup/client");
  var repo = require("clients/git/repo");
  var database = require("clients/git/database");
  var create = util.promisify(require("clients/git/create"));
  var setClientToGit = util.promisify(require("./setup/setClientToGit"));
  var helpers = require("./setup/helpers");

  function bareGit(handle, args) {
    return childProcess
      .execFileSync("git", args, {
        env: Object.assign({}, process.env, { GIT_DIR: repo.directory(handle) }),
      })
      .toString();
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  async function connect(ctx) {
    ctx.repoUrl = await setClientToGit(ctx.user, ctx.blog, ctx.server.port);

    return Client.forContext(ctx);
  }

  it("imports the folder, then takes a push and syncs it", async function () {
    await fs.outputFile(this.blogDirectory + "/first.txt", "Hello");
    await fs.outputFile(this.blogDirectory + "/Sub Folder/ünï côdé.txt", "World");

    var local = await connect(this);

    expect(await fs.pathExists(this.blogDirectory + "/.git")).toBe(false);
    expect((await local.read("/first.txt")).toString()).toBe("Hello");
    expect((await local.read("/Sub Folder/ünï côdé.txt")).toString()).toBe("World");

    // The first sync starts from the import, which the folder already has
    await local.writeAndPush("/pushed.txt", "Pushed");
    await local.writeAndPush("/first.txt", "Changed");

    expect(await fs.pathExists(this.blogDirectory + "/.git")).toBe(false);
    expect(await helpers.blogFile(this, "/pushed.txt")).toEqual(Buffer.from("Pushed"));
    expect(await helpers.blogFile(this, "/first.txt")).toEqual(Buffer.from("Changed"));

    await local.expectSynced();
  });

  it("syncs a first push when no applied commit is recorded", async function () {
    var local = await connect(this);

    await util.promisify(database.removeApplied)(this.blog.id);
    await local.writeAndPush("/pushed.txt", "Pushed");

    expect(await helpers.blogFile(this, "/pushed.txt")).toEqual(Buffer.from("Pushed"));
    await local.expectSynced();
  });

  it("records the import as the commit Blot has applied", async function () {
    await fs.outputFile(this.blogDirectory + "/first.txt", "Hello");
    await connect(this);

    expect(await util.promisify(database.getApplied)(this.blog.id)).toBe(
      bareGit(this.blog.handle, ["rev-parse", "master"]).trim()
    );
  });

  it("commits a big folder in batches of files", async function () {
    for (var i = 0; i < 60; i++) {
      await fs.outputFile(this.blogDirectory + "/file-" + i + ".txt", "File " + i);
    }

    var local = await connect(this);

    expect(Object.keys(await local.tree()).length).toBe(60);
    expect(bareGit(this.blog.handle, ["rev-list", "--count", "master"]).trim()).toBe("3");
    expect(bareGit(this.blog.handle, ["log", "--format=%s", "master"]).trim().split("\n")).toEqual([
      "Add 10 files",
      "Add 25 files",
      "Add 25 files",
    ]);
  });

  it("makes an initial commit for an empty folder", async function () {
    var local = await connect(this);

    expect(Object.keys(await local.tree())).toEqual([]);
    expect(bareGit(this.blog.handle, ["log", "--format=%s", "master"]).trim()).toBe("Initial commit");
    expect(bareGit(this.blog.handle, ["symbolic-ref", "HEAD"]).trim()).toBe("refs/heads/master");
  });

  it("skips files a .gitignore in the folder ignores", async function () {
    await fs.outputFile(this.blogDirectory + "/.gitignore", "*.private\n");
    await fs.outputFile(this.blogDirectory + "/post.txt", "Post");
    await fs.outputFile(this.blogDirectory + "/notes.private", "Notes");

    var local = await connect(this);

    expect(Object.keys(await local.tree()).sort()).toEqual([".gitignore", "post.txt"]);
    expect(await helpers.blogHas(this, "/notes.private")).toBe(true);
  });

  it("waits for the ref lock a push holds before it moves master", async function () {
    await fs.outputFile(this.blogDirectory + "/first.txt", "Hello");

    var handle = this.blog.handle;
    var release = await repo.holdRefLock(this.blog.id);
    var creating = create(this.blog);

    // Wait for the repository to be made, then give it time to commit
    for (var i = 0; i < 100; i++) {
      if (await fs.pathExists(repo.directory(handle) + "/HEAD")) break;
      await sleep(100);
    }

    await sleep(1500);

    // No commit has been put on master
    expect(await fs.pathExists(repo.directory(handle) + "/HEAD")).toBe(true);
    expect(await fs.pathExists(repo.directory(handle) + "/refs/heads/master")).toBe(false);

    await release();
    await creating;

    expect(bareGit(handle, ["ls-tree", "--name-only", "master"]).trim()).toBe("first.txt");
  });

  it("removes what it made if it fails, and leaves a .git directory in the folder alone", async function () {
    await fs.outputFile(this.blogDirectory + "/.git/HEAD", "ref: refs/heads/master\n");

    var error = null;

    try {
      await create(this.blog);
    } catch (err) {
      error = err;
    }

    expect(error).toEqual(jasmine.any(Error));
    expect(await fs.pathExists(repo.directory(this.blog.handle))).toBe(false);
    expect(await fs.pathExists(this.blogDirectory + "/.git/HEAD")).toBe(true);
  });
});
