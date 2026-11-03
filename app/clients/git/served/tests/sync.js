describe("git store served: the blog folder from the store", function () {
  // Shadow mode's set-up: a blog on the git client with a clone (whose
  // blogDirectory is the blog folder), and a memory store per blog
  var setup = require("clients/git/shadow/tests/setup");
  var config = require("config");
  var fs = require("fs-extra");
  var storage = require("storage/folder");
  var database = require("clients/git/database");
  var gitSync = require("clients/git/sync");
  var fallback = require("clients/git/served/fallback");
  var upkeep = require("clients/git/served/upkeep");
  var { EMPTY_TREE } = require("clients/git/materialize");

  setup();

  afterEach(async function () {
    await fallback.idle(this.blog.id);
    await upkeep.idle(this.blog.id);
  });

  async function mirrorAndSwitch(ctx) {
    config.git_store.serve = "";
    await setup.expectMirrored(ctx);
    config.git_store.serve = String(ctx.blog.id);
  }

  function applied(blogID) {
    return new Promise(function (resolve, reject) {
      database.getApplied(blogID, function (err, commit) {
        return err ? reject(err) : resolve(commit);
      });
    });
  }

  // How many times the sync wrote the file (Blot's own build may write others)
  function writesTo(file) {
    return storage.write.calls.allArgs().filter((args) => args[1] === file).length;
  }

  function syncAgain(ctx) {
    return new Promise(function (resolve, reject) {
      gitSync(ctx.blog.id, ctx.blog.handle, function (err) {
        return err ? reject(err) : resolve();
      });
    });
  }

  it("applies pushes into the store to the blog folder: added, changed, nested, removed", async function () {
    await this.local.writeAndPush("/a.txt", "A");
    await this.local.writeAndPush("/gone.txt", "Gone");
    await mirrorAndSwitch(this);

    // EBS is kept behind: the folder must come from the store
    spyOn(fallback, "request").and.returnValue(Promise.resolve());
    var ebsMaster = setup.ebsRefs(this.gitDir)["refs/heads/master"];

    await this.local.commitFiles({ "/a.txt": "A, changed", "/b/c/d.txt": "D", "/Ünïcode.txt": "U" });
    await this.local.remove("/gone.txt");
    await this.local.commit("Remove gone.txt");
    await this.local.push();

    await this.local.expectSynced();
    expect(await applied(this.blog.id)).toBe(await this.local.head());
    expect(await fs.pathExists(this.blogDirectory + "/gone.txt")).toBe(false);
    expect(setup.ebsRefs(this.gitDir)["refs/heads/master"]).toBe(ebsMaster);
  });

  it("moves a renamed file rather than writing it again, and removes the folder it leaves empty", async function () {
    await this.local.writeAndPush("/old/place.txt", "The same bytes");
    await mirrorAndSwitch(this);

    spyOn(storage, "move").and.callThrough();
    spyOn(storage, "write").and.callThrough();

    await this.local.git(["mv", "old/place.txt", "new-place.txt"]);
    await this.local.commit("Move");
    await this.local.push();

    await this.local.expectSynced();
    expect(storage.move).toHaveBeenCalledTimes(1);
    expect(storage.move.calls.argsFor(0).slice(1)).toEqual(["/old/place.txt", "/new-place.txt"]);
    expect(writesTo("/new-place.txt")).toBe(0);
    expect(await fs.pathExists(this.blogDirectory + "/old")).toBe(false);
  });

  it("renames a file to the folder it was in, and a file into a folder of its own name", async function () {
    await this.local.writeAndPush("/a/b.txt", "Same bytes");
    await this.local.writeAndPush("/c", "Other bytes");
    await mirrorAndSwitch(this);

    spyOn(storage, "move").and.callThrough();

    // a/b.txt to a, and c to c/d.txt, in one push
    await this.local.git(["mv", "a/b.txt", "tmp-a"]);
    await this.local.git(["mv", "tmp-a", "a"]);
    await this.local.git(["mv", "c", "tmp-c"]);
    await fs.mkdirp(this.local.path("/c"));
    await this.local.git(["mv", "tmp-c", "c/d.txt"]);
    await this.local.commit("Renames into and out of folders");
    await this.local.push();

    await this.local.expectSynced();
    expect(storage.move).not.toHaveBeenCalled();
    expect(await fs.readFile(this.blogDirectory + "/a", "utf8")).toBe("Same bytes");
    expect(await fs.readFile(this.blogDirectory + "/c/d.txt", "utf8")).toBe("Other bytes");
  });

  it("writes a renamed file from the store when the folder's copy is not the old blob", async function () {
    await this.local.writeAndPush("/old.txt", "The committed bytes");
    await mirrorAndSwitch(this);

    // A sync which wrote other bytes there and failed before moving the
    // applied commit on
    await fs.outputFile(this.blogDirectory + "/old.txt", "Bytes from a sync that failed");

    spyOn(storage, "move").and.callThrough();

    await this.local.git(["mv", "old.txt", "new.txt"]);
    await this.local.commit("Rename");
    await this.local.push();

    await this.local.expectSynced();
    expect(storage.move).not.toHaveBeenCalled();
    expect(await fs.readFile(this.blogDirectory + "/new.txt", "utf8")).toBe("The committed bytes");
    expect(await fs.pathExists(this.blogDirectory + "/old.txt")).toBe(false);
  });

  it("does not write a file whose bytes are already there", async function () {
    await this.local.commitFiles({ "/a.txt": "A", "/b.txt": "B" });
    await this.local.push();
    await mirrorAndSwitch(this);

    // As if nothing had been applied: everything is compared again
    await new Promise((resolve, reject) => database.setApplied(this.blog.id, EMPTY_TREE, (err) => (err ? reject(err) : resolve())));

    spyOn(storage, "write").and.callThrough();
    await syncAgain(this);

    expect(writesTo("/a.txt") + writesTo("/b.txt")).toBe(0);
    await this.local.expectSynced();
    expect(await applied(this.blog.id)).toBe(await this.local.head());
  });

  it("follows a force push", async function () {
    await this.local.writeAndPush("/a.txt", "A");
    await mirrorAndSwitch(this);

    await this.local.writeAndPush("/b.txt", "B");
    await this.local.git(["reset", "--hard", "HEAD~1"]);
    await this.local.commitFiles({ "/c.txt": "C" });
    await this.local.push(["--force", "origin", "master"]);

    await this.local.expectSynced();
  });

  it("fails, and records nothing, when the store has no copy", async function () {
    await this.local.writeAndPush("/a.txt", "A");
    var before = await applied(this.blog.id);

    this.stores[this.blog.id] = require("clients/git/store").createMemoryStore();
    require("clients/git/served/context")._reset();
    config.git_store.serve = String(this.blog.id);

    var failed = await syncAgain(this).then(
      () => null,
      (err) => err
    );

    expect(failed).not.toBe(null);
    expect(failed.message).toContain("no copy");
    expect(await applied(this.blog.id)).toBe(before);
  });
});
