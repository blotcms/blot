// The one-off removal of the live clones left in git blogs' folders
// (liveClones.js, scripts/git/remove-live-clones.js)
describe("git client: removing leftover live clones", function () {
  require("./setup")({ clone: false, client: true });

  var util = require("util");
  var liveClones = require("clients/git/liveClones");
  var folder = require("./setup/folder");

  // A .git in the blog folder as the live-clone code left one: origin at the
  // blog's bare repository on Blot's disk, HEAD on master at `commit`
  async function plantClone(ctx, commit, origin) {
    var url = origin || "/var/www/blot/data/git/" + ctx.blog.handle + ".git";

    await folder.write(ctx.blog.id, "/.git/HEAD", "ref: refs/heads/master\n");
    await folder.write(ctx.blog.id, "/.git/config", '[core]\n\tbare = false\n[remote "origin"]\n\turl = ' + url + "\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n");
    await folder.write(ctx.blog.id, "/.git/refs/heads/master", commit + "\n");
  }

  function check(ctx, options) {
    return liveClones.check(ctx.blog.id, options);
  }

  it("removes a clone whose HEAD the store has on master, only with apply", async function () {
    await this.local.writeAndPush("/a.txt", "A");
    var behind = await this.local.head();
    await this.local.writeAndPush("/b.txt", "B");

    // Behind master is fine: the store has everything it holds
    await plantClone(this, behind);

    expect(await check(this)).toEqual({ blog: this.blog.id, outcome: "removable" });
    expect(await folder.has(this.blog.id, "/.git")).toBe(true);

    expect(await check(this, { apply: true })).toEqual({ blog: this.blog.id, outcome: "removed" });
    expect(await folder.has(this.blog.id, "/.git")).toBe(false);

    // The blog's own files are left alone
    expect((await folder.read(this.blog.id, "/a.txt")).toString()).toBe("A");
  });

  it("keeps a clone whose HEAD is ahead of the store", async function () {
    await this.local.writeAndPush("/a.txt", "A");
    await this.local.commitFiles({ "/not-pushed.txt": "Only in the clone" });

    await plantClone(this, await this.local.head());

    var result = await check(this, { apply: true });

    expect(result.outcome).toBe("kept");
    expect(result.reason).toBe("ahead");
    expect(await folder.has(this.blog.id, "/.git/config")).toBe(true);
  });

  it("keeps a clone at a commit the store names but cannot read", async function () {
    await this.local.writeAndPush("/a.txt", "A");
    await plantClone(this, await this.local.head());

    // Master names the commit, but its pack is gone from the store
    var store = this.stores[this.blog.id];
    for await (var entry of store.list("packs/")) await store.delete(entry.key);
    await require("clients/git/served/context").cache().clear();
    require("clients/git/served/context")._reset();

    var result = await check(this, { apply: true });

    expect(result.outcome).toBe("kept");
    expect(result.reason).toBe("unreadable");
    expect(await folder.has(this.blog.id, "/.git/config")).toBe(true);
  });

  it("keeps a user's own checkout, whose origin is somewhere else", async function () {
    await this.local.writeAndPush("/a.txt", "A");

    await plantClone(this, await this.local.head(), "https://github.com/someone/blog.git");

    var result = await check(this, { apply: true });

    expect(result.outcome).toBe("kept");
    expect(result.reason).toBe("other-origin");
    expect(await folder.has(this.blog.id, "/.git/config")).toBe(true);
  });

  it("keeps a .git on a blog which is not on git, and passes over a blog with none", async function () {
    await this.local.writeAndPush("/a.txt", "A");

    expect((await check(this)).reason).toBe("no-clone");

    await plantClone(this, await this.local.head());
    await util.promisify(require("models/blog").set)(this.blog.id, { client: "" });

    var result = await check(this, { apply: true });

    expect(result.reason).toBe("not-git");
    expect(await folder.has(this.blog.id, "/.git/config")).toBe(true);
  });

  it("counts what it did, by outcome and reason", async function () {
    await this.local.writeAndPush("/a.txt", "A");
    await plantClone(this, await this.local.head());

    var seen = [];
    var counts = await liveClones.run({ apply: true, ids: [this.blog.id, "blog_doesnotexist"], onResult: (r) => seen.push(r) });

    expect(counts).toEqual({ blogs: 2, removable: 0, removed: 1, failed: 0, kept: { "not-git": 1 } });
    expect(seen.map((r) => r.outcome)).toEqual(["removed", "kept"]);
  });

  it("knows Blot's bare repository from anything else", function () {
    expect(liveClones.isOwnBareRepo("/var/www/blot/data/git/handle.git", "handle")).toBe(true);
    expect(liveClones.isOwnBareRepo("/usr/src/app/data/git/handle.git/", "handle")).toBe(true);
    expect(liveClones.isOwnBareRepo("/var/www/blot/data/git/other.git", "handle")).toBe(false);
    expect(liveClones.isOwnBareRepo("https://example.com/git/handle.git", "handle")).toBe(false);
    expect(liveClones.isOwnBareRepo("/somewhere/handle.git", "handle")).toBe(false);
    expect(liveClones.originOf('[remote "upstream"]\n\turl = /a\n[remote "origin"]\n\turl = /b\n')).toBe("/b");
    expect(liveClones.originOf("[core]\n\tbare = false\n")).toBe(null);
  });
});
