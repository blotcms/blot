// Blot's own writes to the repository (client.write and client.remove, used
// for things like preview files), seen by a user with a real git client, and
// what happens when they meet a user's push. Part of the regression suite for
// the git client (#2259): Blot's writes stop being a commit and push in a
// clone in the blog folder, and a user must notice nothing.
describe("git client: Blot's own writes", function () {
  require("./setup")({ clone: false, client: true });

  var write = require("clients/git/write");
  var remove = require("clients/git/remove");
  var helpers = require("./setup/helpers");

  afterEach(async function () {
    await this.local.expectSynced();
  });

  it("asks for the repository to be compacted after a commit, but not after no change", async function () {
    var upkeep = require("clients/git/served/upkeep");

    spyOn(upkeep, "compactAfter");

    await write(this.blog.id, "/collected.txt", "Hello");
    expect(upkeep.compactAfter.calls.count()).toBe(1);
    expect(upkeep.compactAfter.calls.argsFor(0)[0]).toBe(this.blog.id);

    await write(this.blog.id, "/collected.txt", "Hello");
    expect(upkeep.compactAfter.calls.count()).toBe(1);

    await this.local.pull();
  });

  it("writes a file which a pull then brings to the user", async function () {
    var path = "/How/about That name.txt";

    await write(this.blog.id, path, "Hello, world!");

    expect(await helpers.blogFile(this, path)).toEqual(
      Buffer.from("Hello, world!")
    );

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

    expect(await helpers.blogFile(this, "/user-file.txt")).toEqual(
      Buffer.from("From the user")
    );
    expect(await helpers.blogFile(this, "/blot-file.txt")).toEqual(
      Buffer.from("From Blot")
    );
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

    expect(await helpers.blogFile(this, "/from-first.txt")).toEqual(
      Buffer.from("From the first clone")
    );
    expect(await helpers.blogFile(this, "/from-second.txt")).toEqual(
      Buffer.from("From the second clone")
    );
    expect(await first.head()).toBe(await second.head());
  });

  describe("without a commit to make", function () {
    it("makes no commit when the file already has the contents", async function () {
      var path = "/same.txt";

      await write(this.blog.id, path, "Same");

      var before = await this.local.remoteHead();

      await write(this.blog.id, path, "Same");

      expect(await this.local.remoteHead()).toBe(before);
      expect(await helpers.blogFile(this, path)).toEqual(Buffer.from("Same"));

      await write(this.blog.id, path, "Changed");

      expect(await this.local.remoteHead()).not.toBe(before);

      await this.local.pull();
    });

    it("makes no commit when the file removed is not in the repository", async function () {
      await write(this.blog.id, "/there.txt", "There");

      var before = await this.local.remoteHead();

      await remove(this.blog.id, "/not-there.txt");
      await remove(this.blog.id, "/folder/not-there.txt");

      expect(await this.local.remoteHead()).toBe(before);

      await this.local.pull();
    });

    it("removes a file from the blog folder even if the repository doesn't have it", async function () {
      await require("./setup/folder").write(
        this.blog.id,
        "/only-in-the-folder.txt",
        "Only here"
      );

      await remove(this.blog.id, "/only-in-the-folder.txt");

      expect(await helpers.blogHas(this, "/only-in-the-folder.txt")).toBe(
        false
      );
    });
  });

  describe("what a commit has in it", function () {
    it("is by the identity the server's commits have always had, with a message naming the path", async function () {
      await write(this.blog.id, "/Folder/Post.txt", "Hello");
      await this.local.pull();

      var log = (
        await this.local.git(["log", "-1", "--format=%an <%ae>|%cn <%ce>|%s"])
      ).stdout.trim();

      expect(log).toBe(
        "Your Name <you@example.com>|Your Name <you@example.com>|Updated Folder/Post.txt"
      );

      await remove(this.blog.id, "/Folder/Post.txt");
      await this.local.pull();

      log = (await this.local.git(["log", "-1", "--format=%s"])).stdout.trim();

      expect(log).toBe("Removed Folder/Post.txt");
    });

    it("is a commit for each write", async function () {
      var before = Number(
        (await this.local.git(["rev-list", "--count", "HEAD"])).stdout
      );

      for (var i = 0; i < 5; i++)
        await write(this.blog.id, "/file-" + i + ".txt", "File " + i);

      await this.local.pull();

      expect(
        Number((await this.local.git(["rev-list", "--count", "HEAD"])).stdout)
      ).toBe(before + 5);
    });

    it("keeps a file the user made executable executable", async function () {
      await this.local.write("/run.sh", "#!/bin/sh\n");
      await require("fs-extra").chmod(this.local.path("/run.sh"), 0o755);
      await this.local.commit("Add run.sh");
      await this.local.push();

      await write(this.blog.id, "/run.sh", "#!/bin/sh\necho changed\n");
      await write(this.blog.id, "/other.sh", "#!/bin/sh\n");
      await this.local.pull();

      var listing = (
        await this.local.git(["ls-tree", "HEAD", "run.sh", "other.sh"])
      ).stdout;

      expect(listing).toMatch(/^100755 blob [0-9a-f]+\trun\.sh$/m);
      expect(listing).toMatch(/^100644 blob [0-9a-f]+\tother\.sh$/m);
    });
  });

  describe("paths", function () {
    it("writes and removes files with names that are not ASCII, or have spaces and brackets", async function () {
      var paths = [
        "/Café/ünï côdé.md",
        "/日本語/ファイル.txt",
        "/emoji 🎉/[draft] one.txt",
        "/-leading-dash.txt",
      ];

      for (var path of paths)
        await write(this.blog.id, path, "Contents of " + path);

      await this.local.pull();

      for (const path of paths) {
        expect((await this.local.read(path)).toString()).toBe(
          "Contents of " + path
        );
        expect(await helpers.blogFile(this, path)).toEqual(
          Buffer.from("Contents of " + path)
        );
      }

      await remove(this.blog.id, paths[1]);
      await this.local.pull();

      expect(Object.keys(await this.local.tree()).length).toBe(
        paths.length - 1
      );
      expect(await helpers.blogHas(this, paths[1])).toBe(false);
    });

    it("writes a file at the path the blog folder has, in unicode normal form C", async function () {
      // "e" and a combining accent, as some clients send it
      await write(this.blog.id, "/café.txt", "Café");
      await this.local.pull();

      expect((await this.local.read("/café.txt")).toString()).toBe("Café");
      expect(await helpers.blogFile(this, "/café.txt")).toEqual(
        Buffer.from("Café")
      );
    });

    it("removes every file in a folder when the folder is removed", async function () {
      await write(this.blog.id, "/folder/one.txt", "One");
      await write(this.blog.id, "/folder/sub/two.txt", "Two");
      await write(this.blog.id, "/folder.txt", "Not in the folder");

      await remove(this.blog.id, "/folder");
      await this.local.pull();

      expect(Object.keys(await this.local.tree())).toEqual(["folder.txt"]);
      expect(await helpers.blogHas(this, "/folder")).toBe(false);
    });

    it("refuses a path with .git, .. or an empty name in it, and leaves the blog folder alone", async function () {
      for (var path of ["/.git/config", "/a/.GIT/b", "/a/../b", "/"]) {
        var error = null;

        try {
          await require("clients/git/repo").commit(this.blog.id, {
            path: path,
            contents: "x",
          });
        } catch (err) {
          error = err;
        }

        expect(error).toEqual(jasmine.any(Error), path);
      }

      expect(await helpers.blogHas(this, "/b")).toBe(false);
      expect(await helpers.blogHas(this, "/.git")).toBe(false);
    });
  });

  describe("against a user's push", function () {
    var repo = require("clients/git/repo");

    it("waits for the ref lock which a push holds, then commits on what the push left", async function () {
      var before = await this.local.remoteHead();
      var release = await repo.holdRefLock(this.blog.id);
      var writing = write(this.blog.id, "/waiting.txt", "Waiting");
      var finished = false;

      writing.then(function () {
        finished = true;
      });

      await new Promise(function (resolve) {
        setTimeout(resolve, 600);
      });

      expect(finished).toBe(false);
      expect(await this.local.remoteHead()).toBe(before);

      await release();
      await writing;

      expect(await this.local.remoteHead()).not.toBe(before);

      await this.local.pull();

      expect((await this.local.read("/waiting.txt")).toString()).toBe(
        "Waiting"
      );
    });

    it("loses neither a write nor a push when they happen together", async function () {
      var local = this.local;

      await local.commitFiles({ "/from-the-user.txt": "From the user" });

      var results = await Promise.all([
        local.tryPush(),
        write(this.blog.id, "/from-blot.txt", "From Blot"),
      ]);

      // If Blot's write got there first the push is refused, and goes through
      // once the user has pulled it
      if (results[0].code !== 0) {
        expect(results[0].stderr).toMatch(/rejected/);
        await local.pull(["--rebase", "origin", "master"]);
        await local.push();
      }

      await local.waitForSync();
      await local.pull();

      expect(Object.keys(await local.tree()).sort()).toEqual([
        "from-blot.txt",
        "from-the-user.txt",
      ]);
      expect(await helpers.blogFile(this, "/from-the-user.txt")).toEqual(
        Buffer.from("From the user")
      );
      expect(await helpers.blogFile(this, "/from-blot.txt")).toEqual(
        Buffer.from("From Blot")
      );
    });

    it("commits writes made at the same time, one after another, losing none", async function () {
      var names = ["a", "b", "c", "d"];

      await Promise.all(
        names.map(
          function (name) {
            return write(this.blog.id, "/" + name + ".txt", name);
          }.bind(this)
        )
      );

      await this.local.pull();

      expect(Object.keys(await this.local.tree()).sort()).toEqual(
        names.map(function (name) {
          return name + ".txt";
        })
      );
    });
  });
});
