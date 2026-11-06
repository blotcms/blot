// A sync brings the blog folder to a push by writing the paths that changed,
// straight from the git store (served/materialize.js). Nothing else in the
// folder is touched, so a file changed in the folder by hand stays changed.
describe("git client sync: materializing the blog folder", function () {
  require("./setup")({ clone: false, client: true });

  var util = require("util");
  var database = require("clients/git/database");
  var write = util.promisify(require("clients/git/write"));
  var remove = util.promisify(require("clients/git/remove"));
  var helpers = require("./setup/helpers");
  var folder = require("./setup/folder");

  var getApplied = util.promisify(database.getApplied);
  var setApplied = util.promisify(database.setApplied);

  it("lets Blot write on top of a push that removed and changed files", async function () {
    await this.local.commitFiles({
      "/dir/gone.txt": "Gone",
      "/dir/kept.txt": "Kept",
      "/changed.txt": "Before",
    });
    await this.local.push();

    await this.local.remove("/dir/gone.txt");
    await this.local.write("/changed.txt", "After");
    await this.local.commit("Remove and change");
    await this.local.push();

    // A commit on a stale master would be refused when pushed to the
    // repository, or would bring back what the push removed
    await write(this.blog.id, "/dir/by-blot.txt", "By Blot");
    await remove(this.blog.id, "/dir/kept.txt");
    await this.local.pull();

    expect(await this.local.tree()).toEqual({
      "changed.txt": Buffer.from("After"),
      "dir/by-blot.txt": Buffer.from("By Blot"),
    });
    expect(await this.local.head()).toBe(await this.local.remoteHead());
    await this.local.expectSynced();
  });

  it("keeps up after a force push", async function () {
    await this.local.writeAndPush("/old.txt", "Old history");

    await this.local.git(["checkout", "--quiet", "--orphan", "rewritten"]);
    await this.local.git(["rm", "-r", "--force", "--quiet", "."]);
    await this.local.commitFiles({ "/new.txt": "New history" });
    await this.local.push(["--force", "origin", "rewritten:master"]);

    await write(this.blog.id, "/by-blot.txt", "By Blot");
    await this.local.git(["pull", "--quiet", "origin", "master"]);

    expect(await this.local.tree()).toEqual({
      "new.txt": Buffer.from("New history"),
      "by-blot.txt": Buffer.from("By Blot"),
    });
  });

  describe("drift in the blog folder", function () {
    it("is left as it is by a sync, and not committed by Blot's writes", async function () {
      await this.local.commitFiles({ "/drifted.txt": "Pushed", "/other.txt": "Other" });
      await this.local.push();

      await folder.write(this.blog.id, "/drifted.txt", "Changed in the folder");
      await folder.write(this.blog.id, "/untracked.txt", "Not in the repository");

      await this.local.writeAndPush("/later.txt", "Later");

      expect(await helpers.blogFile(this, "/drifted.txt")).toEqual(Buffer.from("Changed in the folder"));
      expect(await helpers.blogFile(this, "/untracked.txt")).toEqual(Buffer.from("Not in the repository"));
      expect(await helpers.blogFile(this, "/later.txt")).toEqual(Buffer.from("Later"));

      await write(this.blog.id, "/by-blot.txt", "By Blot");
      await this.local.pull();

      expect(await this.local.tree()).toEqual({
        "drifted.txt": Buffer.from("Pushed"),
        "other.txt": Buffer.from("Other"),
        "later.txt": Buffer.from("Later"),
        "by-blot.txt": Buffer.from("By Blot"),
      });
    });

    it("is repaired for a path when a push changes that path", async function () {
      await this.local.writeAndPush("/drifted.txt", "Pushed");
      await folder.write(this.blog.id, "/drifted.txt", "Changed in the folder");

      await this.local.writeAndPush("/drifted.txt", "Pushed again");

      expect(await helpers.blogFile(this, "/drifted.txt")).toEqual(Buffer.from("Pushed again"));
    });
  });

  describe("a recorded commit which the store does not have", function () {
    it("syncs the next push by writing every file of the repository", async function () {
      await this.local.writeAndPush("/before.txt", "Before");
      await this.local.git(["checkout", "--quiet", "--orphan", "rewritten"]);
      await this.local.git(["rm", "-r", "--force", "--quiet", "."]);
      await this.local.commitFiles({
        "/kept/one.txt": "One",
        "/kept/two.txt": "Two",
      });
      await this.local.push(["--force", "origin", "rewritten:master"]);

      // As after a force push and a rewrite of the store
      await setApplied(this.blog.id, "0123456789012345678901234567890123456789");

      await this.local.commitFiles({ "/kept/three.txt": "Three" });
      await this.local.push(["origin", "rewritten:master"]);

      expect(await helpers.blogFile(this, "/kept/one.txt")).toEqual(Buffer.from("One"));
      expect(await helpers.blogFile(this, "/kept/two.txt")).toEqual(Buffer.from("Two"));
      expect(await helpers.blogFile(this, "/kept/three.txt")).toEqual(Buffer.from("Three"));
      expect((await helpers.entry(this.blog.id, "/kept/one.txt")).deleted).toBe(false);
      expect(await getApplied(this.blog.id)).toBe(await this.local.remoteHead());
    });
  });
});
