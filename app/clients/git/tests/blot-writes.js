// Blot's own writes to the repository (client.write and client.remove, used
// for things like preview files), seen by a user with a real git client, and
// what happens when they meet a user's push. Part of the regression suite for
// the git client (#2259): Blot's writes stop being a commit and push in a
// clone in the blog folder, and a user must notice nothing.
describe("git client: Blot's own writes", function () {
  require("./setup")({ clone: false, client: true });

  var util = require("util");
  var write = util.promisify(require("clients/git/write"));
  var remove = util.promisify(require("clients/git/remove"));
  var helpers = require("./setup/helpers");

  afterEach(async function () {
    await this.local.expectSynced();
  });

  it("writes a file which a pull then brings to the user", async function () {
    var path = "/How/about That name.txt";

    await write(this.blog.id, path, "Hello, world!");

    expect(await helpers.blogFile(this, path)).toEqual(Buffer.from("Hello, world!"));

    await this.local.pull();

    expect((await this.local.read(path)).toString()).toBe("Hello, world!");
    expect(await this.local.head()).toBe(await this.local.remoteHead());
  });

  it("writes a file with a path in unicode", async function () {
    var path = "/こんにちは世界.txt";

    await write(this.blog.id, path, "こんにちは世界!");
    await this.local.pull();

    expect((await this.local.read(path)).toString()).toBe("こんにちは世界!");
  });

  it("removes a file which a pull then removes for the user", async function () {
    var path = "/How/about That name.txt";

    await write(this.blog.id, path, "Hello, world!");
    await this.local.pull();

    expect((await this.local.read(path)).toString()).toBe("Hello, world!");

    await remove(this.blog.id, path);
    await this.local.pull();

    expect(await helpers.blogHas(this, path)).toBe(false);
    expect(Object.keys(await this.local.tree())).toEqual([]);
  });

  it("removes a file which the user pushed", async function () {
    var path = "/pushed-by-the-user.txt";

    await this.local.writeAndPush(path, "Pushed");
    await remove(this.blog.id, path);
    await this.local.pull();

    expect(await helpers.blogHas(this, path)).toBe(false);
    expect(Object.keys(await this.local.tree())).toEqual([]);
  });

  it("does not error when removing a file which does not exist", async function () {
    await remove(this.blog.id, "/never-existed.txt");
  });

  it("refuses the push of a user who has not pulled Blot's write, then accepts it after a rebase", async function () {
    var local = this.local;

    await local.commitFiles({ "/user-file.txt": "From the user" });
    await write(this.blog.id, "/blot-file.txt", "From Blot");

    // The server has a commit which the user does not
    var refused = await local.tryPush();

    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("[rejected]");
    expect(await helpers.blogHas(this, "/user-file.txt")).toBe(false);

    await local.pull(["--rebase", "origin", "master"]);
    await local.push();

    expect(await helpers.blogFile(this, "/user-file.txt")).toEqual(Buffer.from("From the user"));
    expect(await helpers.blogFile(this, "/blot-file.txt")).toEqual(Buffer.from("From Blot"));
  });

  it("refuses the push of a second clone until it has pulled the first one's push", async function () {
    var first = this.local;
    var second = await first.cloneAgain();

    await first.writeAndPush("/from-first.txt", "From the first clone");

    await second.commitFiles({ "/from-second.txt": "From the second clone" });

    var refused = await second.tryPush();

    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("[rejected]");

    await second.pull(["--rebase", "origin", "master"]);
    await second.push();

    await first.pull();

    expect(await helpers.blogFile(this, "/from-first.txt")).toEqual(Buffer.from("From the first clone"));
    expect(await helpers.blogFile(this, "/from-second.txt")).toEqual(Buffer.from("From the second clone"));
    expect(await first.head()).toBe(await second.head());
  });
});
