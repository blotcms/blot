// A disconnect takes the blog's folder lock from a push's sync still running
// (sync.seize), which stops before it records its commit as applied, so a
// later connection doesn't start from a commit of the old one
describe("git client disconnect during a sync", function () {
  require("./setup")({ clone: false, client: true });

  // The running sync hears the cancel through its lock's heartbeat (3s)
  global.test.timeout(30 * 1000);

  var Blog = require("models/blog");
  var Sync = require("sync");
  var folderLock = require("sync/lock");
  var database = require("clients/git/database");
  var disconnect = require("clients/git/disconnect");
  var repo = require("clients/git/repo");
  var gitSync = require("clients/git/sync");
  var servedSync = require("clients/git/served/sync");
  var { EMPTY_TREE } = require("clients/git/served/materialize");

  function cancelled() {
    return Object.assign(new Error("Sync cancelled: disconnect"), {
      code: "ECANCELED",
    });
  }

  it("stops a sync whose lock is seized before it records the commit", async function () {
    await this.local.writeAndPush("/a.txt", "A");
    await this.local.writeAndPush("/b.txt", "B");
    await database.setApplied(this.blog.id, EMPTY_TREE);

    var controller = new AbortController();
    var updated = [];
    var stub = {
      signal: controller.signal,
      log: function () {},
      update: async function (path) {
        updated.push(path);
        controller.abort(cancelled());
      },
    };

    var err = await servedSync(this.blog.id, stub).then(
      () => null,
      (e) => e
    );

    expect(err && err.code).toBe("ECANCELED");
    expect(updated.length).toBe(1);
    expect(await database.getApplied(this.blog.id)).toBe(EMPTY_TREE);
  });

  it("cancels a running sync, then removes the repository and the applied commit", async function () {
    var blogID = this.blog.id;
    var running = Sync(blogID, async function (folder) {
      await new Promise(function (resolve) {
        folder.signal.addEventListener("abort", resolve, { once: true });
      });
      folder.signal.throwIfAborted();
    }).then(
      () => null,
      (e) => e
    );

    while (!(await folderLock.inspect(blogID)).held)
      await new Promise((resolve) => setTimeout(resolve, 50));

    await disconnect(blogID);

    var err = await running;
    expect(err && err.code).toBe("ECANCELED");
    expect(await repo.exists(blogID)).toBe(false);
    expect(await database.getApplied(blogID)).toBe(null);
    expect((await Blog.get({ id: blogID })).client).toBe("");
  });

  it("applies nothing for a blog no longer on git", async function () {
    await this.local.writeAndPush("/a.txt", "A");
    var before = await database.getApplied(this.blog.id);

    await Blog.set(this.blog.id, { client: "" });
    spyOn(database, "setApplied").and.callThrough();

    await gitSync(this.blog.id, this.blog.handle);

    expect(database.setApplied).not.toHaveBeenCalled();
    expect(await database.getApplied(this.blog.id)).toBe(before);
  });
});
