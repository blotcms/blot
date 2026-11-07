describe("git store: Blot's own writes", function () {
  // A blog on the git client with a clone, and a memory store per blog
  require("clients/git/tests/setup")({ clone: false, client: true });

  var folder = require("clients/git/tests/setup/folder");
  var write = require("clients/git/write");
  var remove = require("clients/git/remove");
  var database = require("clients/git/database");
  var { manifest } = require("clients/git/store");

  function current(ctx) {
    return manifest.read(ctx.stores[ctx.blog.id]);
  }

  function applied(blogID) {
    return database.getApplied(blogID);
  }

  it("commits a write into the store, which a pull brings to the user", async function () {
    await this.local.writeAndPush("/a.txt", "A");

    var before = await current(this);

    await write(this.blog.id, "/How/about That name.txt", "Hello, world!");

    var after = await current(this);
    var master = after.refs["refs/heads/master"];

    expect(after.seq).toBeGreaterThan(before.seq);
    expect(master).not.toBe(before.refs["refs/heads/master"]);
    expect(
      (await folder.read(this.blog.id, "/How/about That name.txt")).toString()
    ).toBe("Hello, world!");
    expect(await applied(this.blog.id)).toBe(master);

    await this.local.pull();
    expect((await this.local.read("/How/about That name.txt")).toString()).toBe(
      "Hello, world!"
    );
    expect(await this.local.head()).toBe(master);
    await this.local.expectSynced();
  });

  it("removes a file, and makes no commit for a write that changes nothing", async function () {
    await this.local.writeAndPush("/a.txt", "A");
    await this.local.writeAndPush("/b.txt", "B");

    await remove(this.blog.id, "/b.txt");
    var removed = await current(this);
    expect(await folder.has(this.blog.id, "/b.txt")).toBe(false);

    await write(this.blog.id, "/a.txt", "A");
    expect((await current(this)).seq).toBe(removed.seq);

    await this.local.pull();
    await this.local.expectSynced();
  });

  it("takes a user's push after Blot's write, once the user has pulled", async function () {
    await this.local.writeAndPush("/a.txt", "A");

    await write(this.blog.id, "/from-blot.txt", "Blot");

    await this.local.commitFiles({ "/from-user.txt": "User" });
    var refused = await this.local.tryPush();
    expect(refused.code).not.toBe(0);

    await this.local.git([
      "pull",
      "--no-rebase",
      "--no-edit",
      "origin",
      "master",
    ]);
    await this.local.push();

    var master = (await current(this)).refs["refs/heads/master"];
    expect(master).toBe(await this.local.head());
    await this.local.expectSynced();
  });

  it("refuses a write when the store has no copy, and leaves the folder alone", async function () {
    await this.local.writeAndPush("/a.txt", "A");

    this.stores[this.blog.id] =
      require("clients/git/store").createMemoryStore();
    require("clients/git/served/context")._reset();

    var failed = await write(this.blog.id, "/new.txt", "New").then(
      () => null,
      (err) => err
    );

    expect(failed).not.toBe(null);
    expect(await folder.has(this.blog.id, "/new.txt")).toBe(false);
  });
});
