// New-folder setup for a blog served from the git store (served/create.js):
// the folder, read through storage/folder alone, becomes the first commit in
// the store and on EBS, and a user can clone it, push and have Blot sync.
describe("git store served: new-folder setup", function () {
  require("clients/git/tests/setup")({ setClientToGit: false, clone: false });

  var fs = require("fs-extra");
  var util = require("util");
  var childProcess = require("child_process");
  var config = require("config");
  var storage = require("storage/folder");
  var Client = require("clients/git/tests/setup/client");
  var repo = require("clients/git/repo");
  var database = require("clients/git/database");
  var context = require("clients/git/served/context");
  var fallback = require("clients/git/served/fallback");
  var upkeep = require("clients/git/served/upkeep");
  var setClientToGit = util.promisify(require("clients/git/tests/setup/setClientToGit"));
  var { createMemoryStore, manifest } = require("clients/git/store");

  var saved;

  beforeEach(function (done) {
    var ctx = this;

    saved = Object.assign({}, config.git_store);
    config.git_store.serve = String(ctx.blog.id);
    config.git_store.shadow = "";
    config.git_store.cache_directory = ctx.tmp + "/git-store-cache";
    config.git_store.cache_bytes = 256 * 1024 * 1024;

    ctx.stores = {};
    context._setObjectStore(function (blogID) {
      return (ctx.stores[blogID] = ctx.stores[blogID] || createMemoryStore());
    });

    require("models/blog").set(ctx.blog.id, { client: "git" }, function (err) {
      if (err) return done.fail(err);
      done();
    });
  });

  afterEach(async function () {
    await fallback.idle(this.blog.id);
    await upkeep.idle(this.blog.id);
    Object.assign(config.git_store, saved);
    context._setObjectStore(null);
  });

  function bareGit(ctx, args) {
    return childProcess
      .execFileSync("git", args, { env: Object.assign({}, process.env, { GIT_DIR: repo.directory(ctx.blog.handle) }) })
      .toString();
  }

  async function connect(ctx) {
    ctx.repoUrl = await setClientToGit(ctx.user, ctx.blog, ctx.server.port);
    return Client.forContext(ctx);
  }

  it("makes the first commit in the store and on EBS from the folder, without the folder as a work tree", async function () {
    await fs.outputFile(this.blogDirectory + "/first.txt", "Hello");
    await fs.outputFile(this.blogDirectory + "/Sub Folder/ünï côdé.txt", "World");
    await fs.outputFile(this.blogDirectory + "/.gitignore", "drafts/\n*.tmp\n");
    await fs.outputFile(this.blogDirectory + "/drafts/secret.txt", "Not this");
    await fs.outputFile(this.blogDirectory + "/scratch.tmp", "Nor this");
    await fs.outputFile(this.blogDirectory + "/big.bin", Buffer.alloc(3 * 1024 * 1024, 1));

    spyOn(storage, "ensureLocal").and.callThrough();

    var local = await connect(this);

    expect(storage.ensureLocal).not.toHaveBeenCalled();
    expect(await fs.pathExists(this.blogDirectory + "/.git")).toBe(false);

    var current = await manifest.read(this.stores[this.blog.id]);
    var master = bareGit(this, ["rev-parse", "master"]).trim();

    expect(current.refs["refs/heads/master"]).toBe(master);
    expect(await util.promisify(database.getApplied)(this.blog.id)).toBe(master);

    expect((await local.read("/first.txt")).toString()).toBe("Hello");
    expect((await local.read("/Sub Folder/ünï côdé.txt")).toString()).toBe("World");
    expect((await local.read("/big.bin")).length).toBe(3 * 1024 * 1024);
    expect(await fs.pathExists(local.path("/drafts/secret.txt"))).toBe(false);
    expect(await fs.pathExists(local.path("/scratch.tmp"))).toBe(false);

    bareGit(this, ["fsck", "--strict"]);

    // The first push is synced from the store
    await local.writeAndPush("/pushed.txt", "Pushed");
    expect(await fs.readFile(this.blogDirectory + "/pushed.txt", "utf8")).toBe("Pushed");
  });

  it("makes an initial commit for an empty folder", async function () {
    var local = await connect(this);

    var current = await manifest.read(this.stores[this.blog.id]);
    expect(current.refs["refs/heads/master"]).toBe(bareGit(this, ["rev-parse", "master"]).trim());
    expect(bareGit(this, ["log", "--format=%s", "master"]).trim()).toBe("Initial commit");

    await local.writeAndPush("/pushed.txt", "Pushed");
    await local.expectSynced();
  });

  it("takes back the store's copy when recording the setup fails, so a retry works", async function () {
    await fs.outputFile(this.blogDirectory + "/first.txt", "Hello");

    var setApplied = database.setApplied;
    var failed = false;

    spyOn(database, "setApplied").and.callFake(function (blogID, commit, callback) {
      if (failed) return setApplied.apply(database, arguments);
      failed = true;
      callback(new Error("Redis is down"));
    });

    var first = await setClientToGit(this.user, this.blog, this.server.port).then(
      () => null,
      (err) => err
    );

    expect(first).not.toBe(null);
    expect(manifest.isEmpty(await manifest.read(this.stores[this.blog.id]))).toBe(true);
    expect(await fs.pathExists(repo.directory(this.blog.handle))).toBe(false);

    var local = await connect(this);

    expect((await local.read("/first.txt")).toString()).toBe("Hello");
    expect((await manifest.read(this.stores[this.blog.id])).refs["refs/heads/master"]).toBe(bareGit(this, ["rev-parse", "master"]).trim());
  });

  it("refuses to set up over a store copy the blog already has, and leaves it alone", async function () {
    await fs.outputFile(this.blogDirectory + "/first.txt", "Hello");
    await connect(this);

    var store = this.stores[this.blog.id];
    var before = await manifest.read(store);

    // A second setup, with the EBS repository gone (create.js would not get
    // past an existing one)
    await fs.remove(repo.directory(this.blog.handle));

    var failed = await setClientToGit(this.user, this.blog, this.server.port).then(
      () => null,
      (err) => err
    );

    expect(failed).not.toBe(null);
    expect(failed.code).toBe("EEXIST");
    // Not create.js's own mkdir: the directory was removed above
    expect(failed.message).toContain("already has a repository in the git store");

    var after = await manifest.read(store);
    expect(after.seq).toBe(before.seq);
    expect(after.refs).toEqual(before.refs);
  });

  it("removes what it made on both sides when it fails", async function () {
    await fs.outputFile(this.blogDirectory + "/first.txt", "Hello");

    // The EBS side fails, after the store has its copy
    var fetch = childProcess.spawn;
    spyOn(childProcess, "spawn").and.callFake(function (command, args, options) {
      if (command === "git" && args.indexOf("fetch") !== -1 && args.indexOf("--no-tags") !== -1) {
        return fetch("git", ["this-is-not-a-command"], options);
      }
      return fetch.apply(childProcess, arguments);
    });

    var failed = await setClientToGit(this.user, this.blog, this.server.port).then(
      () => null,
      (err) => err
    );

    expect(failed).not.toBe(null);
    expect(await fs.pathExists(repo.directory(this.blog.handle))).toBe(false);
    expect(manifest.isEmpty(await manifest.read(this.stores[this.blog.id]))).toBe(true);
  });
});
