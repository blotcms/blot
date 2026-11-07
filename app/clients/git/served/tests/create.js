// New-folder setup in the git store (served/create.js): the folder, read
// through storage/folder alone, becomes the first commit in the store, and a
// user can clone it, push and have Blot sync.
describe("git store: new-folder setup", function () {
  require("clients/git/tests/setup")({ setClientToGit: false, clone: false });

  var fs = require("fs-extra");
  var util = require("util");
  var childProcess = require("child_process");
  var storage = require("storage/folder");
  var folder = require("clients/git/tests/setup/folder");
  var Client = require("clients/git/tests/setup/client");
  var database = require("clients/git/database");
  var context = require("clients/git/served/context");
  var setClientToGit = util.promisify(
    require("clients/git/tests/setup/setClientToGit")
  );
  var { manifest } = require("clients/git/store");
  var { verifyImport } = require("clients/git/store/import");

  async function connect(ctx) {
    ctx.repoUrl = await setClientToGit(ctx.user, ctx.blog, ctx.server.port);
    return Client.forContext(ctx);
  }

  function isEmpty(ctx) {
    return manifest.read(ctx.stores[ctx.blog.id]).then(manifest.isEmpty);
  }

  it("makes the first commit in the store from the folder, without the folder as a work tree", async function () {
    await folder.write(this.blog.id, "/first.txt", "Hello");
    await folder.write(this.blog.id, "/Sub Folder/ünï côdé.txt", "World");
    await folder.write(this.blog.id, "/.gitignore", "drafts/\n*.tmp\n");
    await folder.write(this.blog.id, "/drafts/secret.txt", "Not this");
    await folder.write(this.blog.id, "/scratch.tmp", "Nor this");
    await folder.write(
      this.blog.id,
      "/big.bin",
      Buffer.alloc(3 * 1024 * 1024, 1)
    );

    spyOn(storage, "ensureLocal").and.callThrough();

    var local = await connect(this);

    expect(storage.ensureLocal).not.toHaveBeenCalled();
    expect(await folder.has(this.blog.id, "/.git")).toBe(false);

    var current = await manifest.read(this.stores[this.blog.id]);
    var master = await local.remoteHead();

    expect(current.refs["refs/heads/master"]).toBe(master);
    expect(await database.getApplied(this.blog.id)).toBe(master);

    expect((await local.read("/first.txt")).toString()).toBe("Hello");
    expect((await local.read("/Sub Folder/ünï côdé.txt")).toString()).toBe(
      "World"
    );
    expect((await local.read("/big.bin")).length).toBe(3 * 1024 * 1024);
    expect(await fs.pathExists(local.path("/drafts/secret.txt"))).toBe(false);
    expect(await fs.pathExists(local.path("/scratch.tmp"))).toBe(false);

    // index-pack --strict and fsck --strict on a clone of the store
    await verifyImport({
      store: this.stores[this.blog.id],
      cache: context.cache(),
    });

    // The first push is synced from the store
    await local.writeAndPush("/pushed.txt", "Pushed");
    expect((await folder.read(this.blog.id, "/pushed.txt")).toString()).toBe(
      "Pushed"
    );
  });

  it("makes an initial commit for an empty folder", async function () {
    var local = await connect(this);

    expect(
      (await local.git(["log", "--format=%s", "master"])).stdout.trim()
    ).toBe("Initial commit");

    await local.writeAndPush("/pushed.txt", "Pushed");
    await local.expectSynced();
  });

  it("takes back the store's copy when recording the setup fails, so a retry works", async function () {
    await folder.write(this.blog.id, "/first.txt", "Hello");

    var setApplied = database.setApplied;
    var failed = false;

    spyOn(database, "setApplied").and.callFake(async function () {
      if (failed) return setApplied.apply(database, arguments);
      failed = true;
      throw new Error("Redis is down");
    });

    var first = await setClientToGit(
      this.user,
      this.blog,
      this.server.port
    ).then(
      () => null,
      (err) => err
    );

    expect(first).not.toBe(null);
    expect(await isEmpty(this)).toBe(true);

    var local = await connect(this);

    expect((await local.read("/first.txt")).toString()).toBe("Hello");
    expect(
      (await manifest.read(this.stores[this.blog.id])).refs["refs/heads/master"]
    ).toBe(await local.remoteHead());
  });

  it("refuses to set up over a store copy the blog already has, and leaves it alone", async function () {
    await folder.write(this.blog.id, "/first.txt", "Hello");
    await connect(this);

    var store = this.stores[this.blog.id];
    var before = await manifest.read(store);

    var failed = await setClientToGit(
      this.user,
      this.blog,
      this.server.port
    ).then(
      () => null,
      (err) => err
    );

    expect(failed).not.toBe(null);
    expect(failed.code).toBe("EEXIST");
    expect(failed.message).toContain(
      "already has a repository in the git store"
    );

    var after = await manifest.read(store);
    expect(after.seq).toBe(before.seq);
    expect(after.refs).toEqual(before.refs);
  });

  it("leaves the store empty when it fails before the import", async function () {
    await folder.write(this.blog.id, "/first.txt", "Hello");

    var spawn = childProcess.spawn;
    spyOn(childProcess, "spawn").and.callFake(
      function (command, args, options) {
        if (command === "git" && args.indexOf("fast-import") !== -1) {
          return spawn("git", ["this-is-not-a-command"], options);
        }
        return spawn.apply(childProcess, arguments);
      }
    );

    var failed = await setClientToGit(
      this.user,
      this.blog,
      this.server.port
    ).then(
      () => null,
      (err) => err
    );

    expect(failed).not.toBe(null);
    expect(await isEmpty(this)).toBe(true);
  });

  it("never sets up over a repository the blog has, or takes it back", async function () {
    var local = await connect(this);
    var master = await local.remoteHead();

    var again = await require("clients/git/create")(this.blog).then(
      () => null,
      (err) => err
    );

    expect(again && again.code).toBe("EEXIST");
    expect(
      (await manifest.read(this.stores[this.blog.id])).refs["refs/heads/master"]
    ).toBe(master);
  });
});
