// Blot's commits to a bare repository made with git's plumbing: what they
// leave in it, and what they do when master moves under them. Specs here call
// plumbing.js on a repository of their own, with no blog. What a user sees of
// Blot's writes is in blot-writes.js.
describe("git client plumbing commits", function () {
  var fs = require("fs-extra");
  var path = require("path");
  var childProcess = require("child_process");
  var plumbing = require("clients/git/plumbing");
  var tempDir = require("helper/tempDir");

  beforeEach(async function () {
    this.root = await fs.mkdtemp(path.join(tempDir(), "plumbing-spec-"));
    this.directory = path.join(this.root, "repo.git");

    childProcess.execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=master", this.directory]);

    this.git = function (args, input) {
      return childProcess
        .execFileSync("git", args, {
          env: Object.assign({}, process.env, { GIT_DIR: this.directory }),
          input: input,
        })
        .toString();
    }.bind(this);

    this.files = function () {
      return this.git(["ls-tree", "-r", "-z", "--name-only", "master"])
        .split("\0")
        .filter(Boolean)
        .sort();
    }.bind(this);
  });

  afterEach(function () {
    return fs.remove(this.root);
  });

  function indexes() {
    return fs.readdirSync(tempDir()).filter(function (name) {
      return name.indexOf("git-index-") === 0;
    });
  }

  it("makes the first commit of a repository, with no parent", async function () {
    var result = await plumbing.commitFile(this.directory, { path: "/a.txt", contents: "A" });

    expect(result.parent).toBe(null);
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await plumbing.head(this.directory)).toBe(result.commit);
    expect(this.git(["cat-file", "-p", "master:a.txt"])).toBe("A");
    expect(this.git(["rev-list", "--count", "master"]).trim()).toBe("1");
  });

  it("commits as the identity the server's commits have always had", async function () {
    await plumbing.commitFile(this.directory, { path: "/a.txt", contents: "A" });
    await plumbing.commitFile(this.directory, { path: "/a.txt", contents: null });

    expect(
      this.git(["log", "--format=%an <%ae> %cn <%ce> %s", "master"]).trim().split("\n")
    ).toEqual([
      "Your Name <you@example.com> Your Name <you@example.com> Removed a.txt",
      "Your Name <you@example.com> Your Name <you@example.com> Updated a.txt",
    ]);
  });

  it("makes no commit for contents the file already has", async function () {
    var first = await plumbing.commitFile(this.directory, { path: "/a.txt", contents: "A" });
    var again = await plumbing.commitFile(this.directory, { path: "/a.txt", contents: "A" });

    expect(again).toEqual({ parent: first.commit, commit: null });
    expect(await plumbing.head(this.directory)).toBe(first.commit);
  });

  it("makes no commit for the removal of a file it does not have", async function () {
    var first = await plumbing.commitFile(this.directory, { path: "/a.txt", contents: "A" });
    var removed = await plumbing.commitFile(this.directory, { path: "/b.txt", contents: null });

    expect(removed).toEqual({ parent: first.commit, commit: null });
    expect(await plumbing.head(this.directory)).toBe(first.commit);
  });

  it("makes no commit for a removal in a repository with no commits", async function () {
    var removed = await plumbing.commitFile(this.directory, { path: "/b.txt", contents: null });

    expect(removed).toEqual({ parent: null, commit: null });
    expect(await plumbing.head(this.directory)).toBe(null);
  });

  it("removes the files under a directory", async function () {
    await plumbing.commitFile(this.directory, { path: "/dir/a.txt", contents: "A" });
    await plumbing.commitFile(this.directory, { path: "/dir/sub/b.txt", contents: "B" });
    await plumbing.commitFile(this.directory, { path: "/dir.txt", contents: "C" });
    await plumbing.commitFile(this.directory, { path: "/dir", contents: null });

    expect(this.files()).toEqual(["dir.txt"]);
  });

  it("does not take a name for a pattern", async function () {
    await plumbing.commitFile(this.directory, { path: "/[a].txt", contents: "A" });
    await plumbing.commitFile(this.directory, { path: "/a.txt", contents: "B" });
    await plumbing.commitFile(this.directory, { path: "/*.txt", contents: null });

    expect(this.files()).toEqual(["[a].txt", "a.txt"]);

    await plumbing.commitFile(this.directory, { path: "/[a].txt", contents: null });

    expect(this.files()).toEqual(["a.txt"]);
  });

  it("commits names which are not ASCII, or hold a space, tab or newline", async function () {
    var names = ["こんにちは世界.txt", "café/ünï côdé.md", "tab\there.txt", "new\nline.txt", "-dash.txt"];

    for (var name of names) {
      await plumbing.commitFile(this.directory, { path: "/" + name, contents: name });
    }

    expect(this.files()).toEqual(names.slice().sort());
    expect(this.git(["cat-file", "-p", "master:" + "new\nline.txt"])).toBe("new\nline.txt");
  });

  it("commits the bytes it is given, whatever they are", async function () {
    var bytes = Buffer.from([0, 255, 13, 10, 26, 0]);

    await plumbing.commitFile(this.directory, { path: "/bytes.bin", contents: bytes });
    await plumbing.commitFile(this.directory, { path: "/crlf.txt", contents: "one\r\ntwo\r\n" });

    expect(
      childProcess.execFileSync("git", ["cat-file", "blob", "master:bytes.bin"], {
        env: Object.assign({}, process.env, { GIT_DIR: this.directory }),
      })
    ).toEqual(bytes);
    expect(this.git(["cat-file", "-p", "master:crlf.txt"])).toBe("one\r\ntwo\r\n");
  });

  it("keeps a file executable and makes new ones regular", async function () {
    var index = await plumbing.openIndex(this.directory);
    var blob = (await index.git(["hash-object", "-w", "--stdin"], { input: "#!/bin/sh\n" })).trim();

    await index.git(["update-index", "--add", "--cacheinfo", "100755," + blob + ",run.sh"]);

    var tree = (await index.git(["write-tree"])).trim();
    var commit = await plumbing.commitTree(index, tree, null, "Add run.sh");

    await index.close();
    await plumbing.moveMaster(this.directory, commit, null);

    await plumbing.commitFile(this.directory, { path: "/run.sh", contents: "#!/bin/sh\necho changed\n" });
    await plumbing.commitFile(this.directory, { path: "/new.sh", contents: "#!/bin/sh\n" });

    expect(this.git(["ls-tree", "master", "run.sh", "new.sh"]).split("\n").filter(Boolean).map(function (line) {
      return line.split(" ")[0] + " " + line.split("\t")[1];
    })).toEqual(["100644 new.sh", "100755 run.sh"]);
  });

  it("refuses a path with an empty, . or .. component, or .git in any case", async function () {
    for (var bad of ["", "/", "/.git/config", "/a/.GIT/b", "/.Git", "/a/../b", "/./a", "/a\0b"]) {
      var error = null;

      try {
        await plumbing.commitFile(this.directory, { path: bad, contents: "x" });
      } catch (err) {
        error = err;
      }

      expect(error).toEqual(jasmine.any(Error), JSON.stringify(bad));
    }

    expect(await plumbing.head(this.directory)).toBe(null);
  });

  it("refuses to move master from a commit it is no longer at", async function () {
    var first = await plumbing.commitFile(this.directory, { path: "/a.txt", contents: "A" });
    var second = await plumbing.commitFile(this.directory, { path: "/b.txt", contents: "B" });
    var error = null;

    try {
      await plumbing.moveMaster(this.directory, first.commit, first.commit);
    } catch (err) {
      error = err;
    }

    expect(error.code).toBe("EMOVED");
    expect(await plumbing.head(this.directory)).toBe(second.commit);

    error = null;

    try {
      await plumbing.moveMaster(this.directory, first.commit, null);
    } catch (err) {
      error = err;
    }

    expect(error.code).toBe("EMOVED");
    expect(await plumbing.head(this.directory)).toBe(second.commit);
  });

  it("makes changes made at once on top of one another, losing none", async function () {
    await plumbing.commitFile(this.directory, { path: "/first.txt", contents: "First" });

    // No lock is held, so they race for master. Each one that loses makes its
    // change again on the winner, and a commit can lose to at most the two
    // others, so none runs out of attempts.
    await Promise.all([
      plumbing.commitFile(this.directory, { path: "/a.txt", contents: "A" }),
      plumbing.commitFile(this.directory, { path: "/b.txt", contents: "B" }),
      plumbing.commitFile(this.directory, { path: "/first.txt", contents: null }),
    ]);

    expect(this.files()).toEqual(["a.txt", "b.txt"]);
    expect(this.git(["rev-list", "--count", "master"]).trim()).toBe("4");
    this.git(["fsck", "--strict"]);
  });

  it("leaves no temporary index behind, and uses a different one each time", async function () {
    var before = indexes();
    var seen = [];

    // Each commit is made from a fresh, empty index directory
    var open = plumbing.openIndex;
    var first = await open(this.directory);
    var second = await open(this.directory);

    seen = indexes().filter(function (name) {
      return before.indexOf(name) === -1;
    });

    expect(seen.length).toBe(2);

    await first.close();
    await second.close();

    await plumbing.commitFile(this.directory, { path: "/a.txt", contents: "A" });
    await plumbing.commitFile(this.directory, { path: "/a.txt", contents: "A" });
    await plumbing.commitFile(this.directory, { path: "/a.txt", contents: null });

    expect(indexes()).toEqual(before);
  });
});
