describe("git store: the blog folder from the store", function () {
  // A blog on the git client with a clone, and a memory store per blog; the
  // blog folder is looked at through storage/folder
  require("clients/git/tests/setup")({ clone: false, client: true });

  var fs = require("fs-extra");
  var storage = require("storage/folder");
  var folder = require("clients/git/tests/setup/folder");
  var database = require("clients/git/database");
  var gitSync = require("clients/git/sync");
  var { EMPTY_TREE } = require("clients/git/served/materialize");

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


    await this.local.commitFiles({ "/a.txt": "A, changed", "/b/c/d.txt": "D", "/Ünïcode.txt": "U" });
    await this.local.remove("/gone.txt");
    await this.local.commit("Remove gone.txt");
    await this.local.push();

    await this.local.expectSynced();
    expect(await applied(this.blog.id)).toBe(await this.local.head());
    expect(await folder.has(this.blog.id, "/gone.txt")).toBe(false);
  });

  it("moves a renamed file rather than writing it again, and removes the folder it leaves empty", async function () {
    await this.local.writeAndPush("/old/place.txt", "The same bytes");

    spyOn(storage, "move").and.callThrough();
    spyOn(storage, "write").and.callThrough();

    await this.local.git(["mv", "old/place.txt", "new-place.txt"]);
    await this.local.commit("Move");
    await this.local.push();

    await this.local.expectSynced();
    expect(storage.move).toHaveBeenCalledTimes(1);
    expect(storage.move.calls.argsFor(0).slice(1)).toEqual(["/old/place.txt", "/new-place.txt"]);
    expect(writesTo("/new-place.txt")).toBe(0);
    expect(await folder.has(this.blog.id, "/old")).toBe(false);
  });

  it("renames a file to the folder it was in, and a file into a folder of its own name", async function () {
    await this.local.writeAndPush("/a/b.txt", "Same bytes");
    await this.local.writeAndPush("/c", "Other bytes");

    spyOn(storage, "move").and.callThrough();

    // a/b.txt to a, and c to c/d.txt, in one push (the same blobs at the new
    // paths, which is all the diff sees)
    await fs.remove(this.local.path("/a"));
    await fs.outputFile(this.local.path("/a"), "Same bytes");
    await fs.remove(this.local.path("/c"));
    await fs.outputFile(this.local.path("/c/d.txt"), "Other bytes");
    await this.local.commit("Renames into and out of folders");
    await this.local.push();

    await this.local.expectSynced();
    expect(storage.move).not.toHaveBeenCalled();
    expect((await folder.read(this.blog.id, "/a")).toString()).toBe("Same bytes");
    expect((await folder.read(this.blog.id, "/c/d.txt")).toString()).toBe("Other bytes");
  });

  it("writes a renamed file from the store when the folder's copy is not the old blob", async function () {
    await this.local.writeAndPush("/old.txt", "The committed bytes");

    // A sync which wrote other bytes there and failed before moving the
    // applied commit on
    await folder.write(this.blog.id, "/old.txt", "Bytes from a sync that failed");

    spyOn(storage, "move").and.callThrough();

    await this.local.git(["mv", "old.txt", "new.txt"]);
    await this.local.commit("Rename");
    await this.local.push();

    await this.local.expectSynced();
    expect(storage.move).not.toHaveBeenCalled();
    expect((await folder.read(this.blog.id, "/new.txt")).toString()).toBe("The committed bytes");
    expect(await folder.has(this.blog.id, "/old.txt")).toBe(false);
  });

  it("keeps a file renamed from its NFD name to its NFC name", async function () {
    var nfd = "/Cafe\u0301.txt";
    var nfc = "/Caf\u00e9.txt";

    await this.local.writeAndPush(nfd, "Same bytes");

    // storage/folder names it in NFC, so both names are one file there
    await fs.move(this.local.path(nfd), this.local.path(nfc));
    await this.local.commit("NFD to NFC");
    await this.local.push();

    expect((await folder.read(this.blog.id, nfc)).toString()).toBe("Same bytes");
    await this.local.expectSynced();
  });

  it("does not write a file whose bytes are already there", async function () {
    await this.local.commitFiles({ "/a.txt": "A", "/b.txt": "B" });
    await this.local.push();

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

    var failed = await syncAgain(this).then(
      () => null,
      (err) => err
    );

    expect(failed).not.toBe(null);
    expect(failed.message).toContain("no copy");
    expect(await applied(this.blog.id)).toBe(before);
  });
});
