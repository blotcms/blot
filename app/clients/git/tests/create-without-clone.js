// The first import of a blog folder into a new repository (create.js) is made
// in the git store, with no live clone, and a user can clone it, push and have
// Blot sync the push straight away.
describe("git client create without a live clone", function () {
  require("./setup")({ setClientToGit: false, clone: false });

  var fs = require("fs-extra");
  var util = require("util");
  var Client = require("./setup/client");
  var repo = require("clients/git/repo");
  var database = require("clients/git/database");
  var create = util.promisify(require("clients/git/create"));
  var setClientToGit = util.promisify(require("./setup/setClientToGit"));
  var helpers = require("./setup/helpers");

  var inStore = util.promisify(repo.exists);

  // git in a clone, its output
  async function inClone(local, args) {
    return (await local.git(args)).stdout;
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  // The clone URL of a blog whose repository is already set up
  async function setClientToGitUrl(ctx) {
    var token = await util.promisify(database.getToken)(ctx.blog.owner);
    return "http://" + encodeURIComponent(ctx.user.email) + ":" + token + "@127.0.0.1:" + ctx.server.port + "/clients/git/end/" + ctx.blog.handle + ".git";
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
    var local = await connect(this);

    expect(await util.promisify(database.getApplied)(this.blog.id)).toBe(await local.remoteHead());
  });

  it("commits a big folder in one commit", async function () {
    for (var i = 0; i < 60; i++) {
      await fs.outputFile(this.blogDirectory + "/file-" + i + ".txt", "File " + i);
    }

    var local = await connect(this);

    expect(Object.keys(await local.tree()).length).toBe(60);
    expect((await inClone(local, ["log", "--format=%s", "master"])).trim()).toBe("Add files");
  });

  it("makes an initial commit for an empty folder", async function () {
    var local = await connect(this);

    expect(Object.keys(await local.tree())).toEqual([]);
    expect((await inClone(local, ["log", "--format=%s", "master"])).trim()).toBe("Initial commit");
    expect((await inClone(local, ["ls-remote", "--symref", "origin", "HEAD"])).split("\n")[0]).toBe("ref: refs/heads/master\tHEAD");
  });

  it("skips files a .gitignore in the folder ignores", async function () {
    await fs.outputFile(this.blogDirectory + "/.gitignore", "*.private\n");
    await fs.outputFile(this.blogDirectory + "/post.txt", "Post");
    await fs.outputFile(this.blogDirectory + "/notes.private", "Notes");

    var local = await connect(this);

    expect(Object.keys(await local.tree()).sort()).toEqual([".gitignore", "post.txt"]);
    expect(await helpers.blogHas(this, "/notes.private")).toBe(true);
  });

  it("waits for the ref lock a push holds before it saves the repository", async function () {
    await fs.outputFile(this.blogDirectory + "/first.txt", "Hello");
    await util.promisify(require("models/blog").set)(this.blog.id, { client: "git" });

    var release = await repo.holdRefLock(this.blog.id);
    var creating = create(this.blog);

    await sleep(1500);

    // Nothing has been saved
    expect(await inStore(this.blog.id)).toBe(false);

    await release();
    await creating;

    expect(await inStore(this.blog.id)).toBe(true);

    var local = await Client.forContext(this, { url: await setClientToGitUrl(this) });
    expect(Object.keys(await local.tree())).toEqual(["first.txt"]);
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
    expect(await inStore(this.blog.id)).toBe(false);
    expect(await fs.pathExists(this.blogDirectory + "/.git/HEAD")).toBe(true);
  });
});
