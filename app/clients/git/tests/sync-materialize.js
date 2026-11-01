// IMPLEMENTATION-SPECIFIC. A sync brings the blog folder to a push by writing
// the paths that changed, straight from the bare repository (materialize.js,
// #2259 PR 7). The live clone in the blog folder's .git directory is no longer
// how it finds changes, and since PR 8 Blot's own writes are not made in it, but
// a blog that has one keeps it at master, so that this code can be rolled back
// (the specs here give the blog one, as older blogs have). And as nothing else
// in the folder is touched, a file changed in the folder by hand stays changed.
// Delete the live clone specs here when the live clones go (PR 9).
describe("git client sync: materializing the blog folder", function () {
  require("./setup")({ clone: false, client: true });

  beforeEach(async function () {
    await require("./setup/liveClone")(this);
  });

  var util = require("util");
  var fs = require("fs-extra");
  var { execFile } = require("child_process");
  var Git = require("clients/git/git");
  var repo = require("clients/git/repo");
  var database = require("clients/git/database");
  var write = util.promisify(require("clients/git/write"));
  var remove = util.promisify(require("clients/git/remove"));
  var helpers = require("./setup/helpers");

  var getApplied = util.promisify(database.getApplied);
  var setApplied = util.promisify(database.setApplied);

  // The live clone
  function live(ctx) {
    return Git(ctx.blogDirectory);
  }

  describe("the live clone", function () {
    it("is at the pushed commit, with a clean index and working tree", async function () {
      await this.local.commitFiles({
        "/one.txt": "One",
        "/nested/deeper/two.txt": "Two",
        "/three.txt": "Three",
      });
      await this.local.push();

      expect((await live(this).raw(["rev-parse", "HEAD"])).trim()).toBe(await this.local.remoteHead());
      expect(await live(this).raw(["status", "--porcelain"])).toBe("");

      await this.local.remove("/nested/deeper/two.txt");
      await this.local.write("/one.txt", "One, changed");
      await this.local.commit("Change one file and remove another");
      await this.local.push();

      expect((await live(this).raw(["rev-parse", "HEAD"])).trim()).toBe(await this.local.remoteHead());
      expect(await live(this).raw(["status", "--porcelain"])).toBe("");
    });

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

      // A commit on a stale HEAD or index would be refused when pushed to
      // the repository, or would bring back what the push removed
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
  });

  describe("drift in the blog folder", function () {
    it("is left as it is by a sync, and not committed by Blot's writes", async function () {
      await this.local.commitFiles({ "/drifted.txt": "Pushed", "/other.txt": "Other" });
      await this.local.push();

      await fs.writeFile(this.blogDirectory + "/drifted.txt", "Changed in the folder");
      await fs.writeFile(this.blogDirectory + "/untracked.txt", "Not in the repository");

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
      await fs.writeFile(this.blogDirectory + "/drifted.txt", "Changed in the folder");

      await this.local.writeAndPush("/drifted.txt", "Pushed again");

      expect(await helpers.blogFile(this, "/drifted.txt")).toEqual(Buffer.from("Pushed again"));
    });
  });

  describe("a recorded commit which the repository has lost", function () {
    function collectGarbage(ctx) {
      return new Promise(function (resolve, reject) {
        execFile(
          "git",
          ["gc", "--prune=now", "--quiet"],
          { cwd: repo.directory(ctx.blog.handle) },
          function (err, stdout, stderr) {
            if (err) return reject(new Error(err.message + stderr));
            resolve();
          }
        );
      });
    }

    it("syncs the next push by writing every file of the repository", async function () {
      await this.local.writeAndPush("/before.txt", "Before");
      await this.local.git(["checkout", "--quiet", "--orphan", "rewritten"]);
      await this.local.git(["rm", "-r", "--force", "--quiet", "."]);
      await this.local.commitFiles({
        "/kept/one.txt": "One",
        "/kept/two.txt": "Two",
      });

      var old = await this.local.remoteHead();

      await this.local.push(["--force", "origin", "rewritten:master"]);

      // The recorded commit, and where the live clone is, are the commit which
      // the force push replaced. It is gone from the repository once it is
      // collected, as it would be long after.
      await setApplied(this.blog.id, old);
      await live(this).raw(["reset", "--quiet", "--soft", old]);
      await collectGarbage(this);

      var bare = Git(repo.directory(this.blog.handle));

      expect(await bare.raw(["cat-file", "-t", old]).catch(() => "gone")).toBe("gone");

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
