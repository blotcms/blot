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
    // Changed by #2259 PR 7: files are written to the blog folder as the raw
    // committed bytes, and the attributes below no longer apply.
    it("ignores eol=crlf in the files written to the blog folder", async function () {
      await this.local.commitFiles({
        "/.gitattributes": "* text=auto eol=crlf\n",
        "/lines.txt": "one\ntwo\nthree\n",
      });
      await this.local.push();

      // The clone has the line endings the user committed
      expect(await this.local.read("/lines.txt")).toEqual(Buffer.from("one\ntwo\nthree\n"));

      // and so does the blog folder
      expect(await helpers.blogFile(this, "/lines.txt")).toEqual(
        Buffer.from("one\ntwo\nthree\n")
      );
    });

    // Changed by #2259 PR 7: the raw committed bytes, with $Id$ left as it is.
    it("does not expand the ident attribute in the files written to the blog folder", async function () {
      await this.local.commitFiles({
        "/.gitattributes": "*.txt ident\n",
        "/ident.txt": "$Id$\n",
      });
      await this.local.push();

      expect(await this.local.read("/ident.txt")).toEqual(Buffer.from("$Id$\n"));
      expect(await helpers.blogFile(this, "/ident.txt")).toEqual(Buffer.from("$Id$\n"));
    });
  });

  describe("branches", function () {
    // Changed by #2259 PR 6: a push which includes any ref other than master
    // is rejected as a whole, whatever the order of its refs. Master is not
    // updated either, and no sync starts.
    ["master sneaky", "sneaky master"].forEach(function (order) {
      it("rejects a branch pushed together with master (" + order + ")", async function () {
        var local = this.local;
        var before = await local.remoteHead();

        await local.commitFiles({ "/with-a-branch.txt": "Pushed with a branch" });
        await local.git(["branch", "sneaky"]);

        var pushed = await local.tryPush(["origin"].concat(order.split(" ")));

        expect(pushed.code).not.toBe(0);
        expect(pushed.stderr).toContain("only the master branch is allowed");

        await local.waitForSync();

        expect(await local.remoteHead("sneaky")).toBeNull();
        expect(await local.remoteHead()).toBe(before);
        expect(await helpers.blogHas(this, "/with-a-branch.txt")).toBe(false);
      });
    });
  });

  describe("symbolic links and submodules", function () {
    // Changed by #2259 PR 6: the push is refused, with a message, before the
    // client is told "ok". Nothing reaches the repository.
    it("refuses a push with a symbolic link, with a message", async function () {
      var local = this.local;
      var before = await local.remoteHead();

      await local.write("/alongside.txt", "In the same commit as the link");
      await fs.symlink("alongside.txt", local.path("/link.txt"));
      await local.commit("Add a symbolic link");

      var pushed = await local.tryPush();

      // The client is told why
      expect(pushed.code).not.toBe(0);
      expect(pushed.stderr).toContain("remote: refs/heads/master: Git blogs support regular files only");
      expect(await local.remoteHead()).toBe(before);

      await local.waitForSync();

      // and the blog folder has nothing from the commit
      expect(await helpers.blogHas(this, "/alongside.txt")).toBe(false);
      expect(await helpers.blogHas(this, "/link.txt")).toBe(false);

      // Replacing the link with a regular file lets the push go through
      await local.remove("/link.txt");
      await local.writeAndPush("/link.txt", "Now a regular file");

      expect(await helpers.blogFile(this, "/alongside.txt")).toEqual(
        Buffer.from("In the same commit as the link")
      );
      await local.expectSynced();
    });

    // Changed by #2259 PR 6: as above.
    it("refuses a push with a submodule, with a message", async function () {
      var local = this.local;
      var before = await local.remoteHead();

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

      expect(pushed.code).not.toBe(0);
      expect(pushed.stderr).toContain("remote: refs/heads/master: Git blogs support regular files only");
      expect(await local.remoteHead()).toBe(before);

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
