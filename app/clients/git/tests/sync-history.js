// What happens to the blog folder and its entries for different shapes of
// history: many files, everything removed, reverts, empty commits, rewritten
// history and tags. Part of the regression suite for the git client (#2259):
// these specs only use a real git client over HTTP, so they must keep passing
// when the server side is rewritten.
describe("git client sync: history", function () {
  require("./setup")({ clone: false, client: true });

  var fs = require("fs-extra");
  var Entry = require("models/entry");
  var helpers = require("./setup/helpers");
  var readDirectories = require("./setup/client").readDirectories;

  afterEach(async function () {
    await this.local.expectSynced();
  });

  function entries(blogID, paths) {
    return new Promise(function (resolve) {
      Entry.get(blogID, paths, function (entries) {
        resolve(entries);
      });
    });
  }

  it("syncs 200 files in a single push, and builds their entries", async function () {
    var files = {};
    var paths = [];

    for (var i = 0; i < 200; i++) {
      var path = "/bulk/" + (i % 10) + "/file-" + i + ".txt";
      paths.push(path);
      files[path] = "File number " + i;
    }

    await this.local.commitFiles(files, "200 files");
    await this.local.push(["origin", "master"], { timeout: 150 * 1000 });

    expect(Object.keys(await helpers.blogFiles(this)).length).toBe(200);

    var built = await entries(this.blog.id, paths);

    expect(built.length).toBe(200);
    expect(
      built.filter(function (entry) {
        return !entry.deleted;
      }).length
    ).toBe(200);
  }, 200 * 1000);

  it("removes every file in a single push", async function () {
    var one = "/one.txt";

    await this.local.commitFiles({
      [one]: "One",
      "/nested/two.txt": "Two",
      "/nested/deeper/three.txt": "Three",
      "/four.md": "Four",
    });
    await this.local.push();

    expect(Object.keys(await helpers.blogFiles(this)).length).toBe(4);
    expect((await helpers.entry(this.blog.id, one)).deleted).toBe(false);

    await this.local.git(["rm", "-r", "--quiet", "."]);
    await this.local.git(["commit", "--quiet", "--message", "Remove everything"]);
    await this.local.push();

    expect(await helpers.blogFiles(this)).toEqual({});
    expect(await readDirectories(this.blogDirectory)).toEqual([]);
    expect((await helpers.entry(this.blog.id, one)).deleted).toBe(true);
  });

  it("handles a revert commit", async function () {
    var path = "/reverted.txt";

    await this.local.writeAndPush(path, "Added, then reverted");
    expect(await helpers.blogHas(this, path)).toBe(true);

    await this.local.git(["revert", "--no-edit", "HEAD"]);
    await this.local.push();

    expect(await helpers.blogHas(this, path)).toBe(false);
    expect((await helpers.entry(this.blog.id, path)).deleted).toBe(true);
  });

  it("handles an empty commit", async function () {
    await this.local.writeAndPush("/before-empty.txt", "Before the empty commit");

    var before = await helpers.blogFiles(this);

    await this.local.commit("Nothing changed", { allowEmpty: true });
    await this.local.push();

    expect(await helpers.blogFiles(this)).toEqual(before);
  });

  it("handles an amended commit, force pushed, which removes a file", async function () {
    await this.local.writeAndPush("/kept.txt", "Kept");
    await this.local.writeAndPush("/amended-away.txt", "Pushed, then amended away");

    expect(await helpers.blogHas(this, "/amended-away.txt")).toBe(true);

    await this.local.remove("/amended-away.txt");
    await this.local.git(["add", "--all"]);
    await this.local.git(["commit", "--quiet", "--amend", "--allow-empty", "--message", "Amended"]);

    // A plain push is refused, a forced one is not
    var refused = await this.local.tryPush();
    expect(refused.code).not.toBe(0);

    await this.local.push(["--force", "origin", "master"]);

    expect(await helpers.blogHas(this, "/amended-away.txt")).toBe(false);
    expect(await helpers.blogHas(this, "/kept.txt")).toBe(true);
    expect((await helpers.entry(this.blog.id, "/amended-away.txt")).deleted).toBe(true);
  });

  it("handles a force push of unrelated history", async function () {
    await this.local.commitFiles({
      "/old/one.txt": "From the old history",
      "/old/two.txt": "From the old history",
    });
    await this.local.push();

    // A new root commit, which shares nothing with what the server has
    await this.local.git(["checkout", "--quiet", "--orphan", "unrelated"]);
    await this.local.git(["rm", "-r", "--force", "--quiet", "."]);
    await this.local.commitFiles({ "/new/three.txt": "From the new history" });
    await this.local.push(["--force", "origin", "unrelated:master"]);

    expect(Object.keys(await helpers.blogFiles(this))).toEqual(["new/three.txt"]);
    expect((await helpers.entry(this.blog.id, "/old/one.txt")).deleted).toBe(true);
    expect((await helpers.entry(this.blog.id, "/new/three.txt")).deleted).toBe(false);
  });

  it("accepts a pushed tag, and does not change the blog for it", async function () {
    var local = this.local;

    await local.writeAndPush("/before-tag.txt", "Before the tag");
    await local.git(["tag", "light"]);
    await local.git(["tag", "--annotate", "--message", "An annotated tag", "annotated"]);

    var pushed = await local.tryPush(["origin", "light", "annotated"]);

    expect(pushed.code).toBe(0);

    var tags = (await local.git(["ls-remote", "--tags", "origin"])).stdout;

    expect(tags).toContain("refs/tags/light");
    expect(tags).toContain("refs/tags/annotated");

    // A tag on a commit which master does not have yet: pushing the tag
    // alone does not put that commit's files in the blog folder
    await local.commitFiles({ "/only-tagged.txt": "Tagged, not on master" });
    await local.git(["tag", "ahead"]);

    expect((await local.tryPush(["origin", "ahead"])).code).toBe(0);
    expect(await helpers.blogHas(this, "/only-tagged.txt")).toBe(false);

    // Pushing master puts it there
    await local.push();

    expect(await helpers.blogHas(this, "/only-tagged.txt")).toBe(true);
  });
});
