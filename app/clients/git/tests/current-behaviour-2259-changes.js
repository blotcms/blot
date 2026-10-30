// Behaviour of the git client today which https://github.com/blotcms/blot/issues/2259
// changes on purpose. Everything else in the git client's specs must survive
// that rewrite unchanged; the specs in this file are expected to be edited by
// it, each to the new behaviour named in its comment. Use a real git client
// over HTTP, like the rest of the regression suite.
describe("current behaviour that #2259 changes", function () {
  require("./setup")({ clone: false, client: true });

  var fs = require("fs-extra");
  var helpers = require("./setup/helpers");

  describe(".gitattributes", function () {
    // New behaviour: files are written to the blog folder as the raw
    // committed bytes, and the attributes below stop applying.
    it("applies eol=crlf to the files written to the blog folder", async function () {
      await this.local.commitFiles({
        "/.gitattributes": "* text=auto eol=crlf\n",
        "/lines.txt": "one\ntwo\nthree\n",
      });
      await this.local.push();

      // The clone has the line endings the user committed
      expect(await this.local.read("/lines.txt")).toEqual(Buffer.from("one\ntwo\nthree\n"));

      // The blog folder was checked out with the attribute applied
      expect(await helpers.blogFile(this, "/lines.txt")).toEqual(
        Buffer.from("one\r\ntwo\r\nthree\r\n")
      );
    });

    // New behaviour: the raw committed bytes, with $Id$ left as it is.
    it("expands the ident attribute in the files written to the blog folder", async function () {
      await this.local.commitFiles({
        "/.gitattributes": "*.txt ident\n",
        "/ident.txt": "$Id$\n",
      });
      await this.local.push();

      expect(await this.local.read("/ident.txt")).toEqual(Buffer.from("$Id$\n"));
      expect((await helpers.blogFile(this, "/ident.txt")).toString()).toMatch(
        /^\$Id: [0-9a-f]{40} \$\n$/
      );
    });
  });

  describe("branches", function () {
    // New behaviour: a push which includes any ref other than master is
    // rejected as a whole, whatever the order of its refs.
    it("accepts a branch pushed together with master", async function () {
      var local = this.local;

      await local.commitFiles({ "/with-a-branch.txt": "Pushed with a branch" });
      await local.git(["branch", "sneaky"]);

      var pushed = await local.tryPush(["origin", "master", "sneaky"]);

      expect(pushed.code).toBe(0);
      await local.waitForSync();

      expect(await local.remoteHead("sneaky")).toBe(await local.head());
      expect(await helpers.blogHas(this, "/with-a-branch.txt")).toBe(true);
    });

    // New behaviour: as above.
    it("accepts a branch pushed together with master, in the other order", async function () {
      var local = this.local;

      await local.commitFiles({ "/with-a-branch.txt": "Pushed with a branch" });
      await local.git(["branch", "sneaky"]);

      var pushed = await local.tryPush(["origin", "sneaky", "master"]);

      expect(pushed.code).toBe(0);
      await local.waitForSync();

      expect(await local.remoteHead("sneaky")).toBe(await local.head());
      expect(await helpers.blogHas(this, "/with-a-branch.txt")).toBe(true);
    });
  });

  describe("symbolic links and submodules", function () {
    // New behaviour: the push is refused, with a message, before the client
    // is told "ok". Nothing reaches the repository.
    it("accepts a push with a symbolic link, then fails to sync it", async function () {
      var local = this.local;

      await local.write("/alongside.txt", "In the same commit as the link");
      await fs.symlink("alongside.txt", local.path("/link.txt"));
      await local.commit("Add a symbolic link");

      var pushed = await local.tryPush();

      // The client is told the push worked
      expect(pushed.code).toBe(0);
      expect(await local.remoteHead()).toBe(await local.head());

      await local.waitForSync();

      // The sync failed: the blog folder has nothing from the commit
      expect(await helpers.blogHas(this, "/alongside.txt")).toBe(false);
      expect(await helpers.blogHas(this, "/link.txt")).toBe(false);

      // Replacing the link with a regular file lets the sync go through
      await local.remove("/link.txt");
      await local.writeAndPush("/link.txt", "Now a regular file");

      expect(await helpers.blogFile(this, "/alongside.txt")).toEqual(
        Buffer.from("In the same commit as the link")
      );
      await local.expectSynced();
    });

    // New behaviour: as above.
    it("accepts a push with a submodule, then fails to sync it", async function () {
      var local = this.local;

      await local.write("/alongside.txt", "In the same commit as the submodule");
      await local.git(["add", "--all"]);
      await local.git([
        "update-index",
        "--add",
        "--cacheinfo",
        "160000," + (await local.head()) + ",vendor/submodule",
      ]);
      await local.git(["commit", "--quiet", "--message", "Add a submodule"]);

      var pushed = await local.tryPush();

      expect(pushed.code).toBe(0);
      expect(await local.remoteHead()).toBe(await local.head());

      await local.waitForSync();

      expect(await helpers.blogHas(this, "/alongside.txt")).toBe(false);
      expect(await helpers.blogHas(this, "/vendor")).toBe(false);

      await local.git(["rm", "--cached", "--quiet", "vendor/submodule"]);
      await local.git(["commit", "--quiet", "--message", "Remove the submodule"]);
      await local.push();

      expect(await helpers.blogFile(this, "/alongside.txt")).toEqual(
        Buffer.from("In the same commit as the submodule")
      );
      await local.expectSynced();
    });
  });
});
