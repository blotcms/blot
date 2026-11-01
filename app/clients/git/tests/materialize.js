// IMPLEMENTATION-SPECIFIC. materialize.js brings a blog folder from one commit
// to another by reading the repository (#2259). The specs that go through a
// real git client and a sync are in sync-paths.js and sync-history.js; these
// call it directly, with history made by plumbing so that it can hold what a
// push is no longer allowed to: paths a real client would not send, and
// shapes that some filesystems cannot show at once (names that differ by case).
describe("git client: materialize", function () {
  var fs = require("fs-extra");
  var os = require("os");
  var crypto = require("crypto");
  var path = require("path");
  var { execFile } = require("child_process");
  var materialize = require("clients/git/materialize");

  var EMPTY_TREE = materialize.EMPTY_TREE;
  var IDENTITY = {
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };

  beforeEach(async function () {
    this.tmp = await fs.mkdtemp(os.tmpdir() + "/materialize-");
    this.directory = this.tmp + "/repo.git";
    this.folder = this.tmp + "/folder";
    this.outside = this.tmp + "/outside";
    this.index = this.tmp + "/index";
    this.logs = [];
    this.head = null;

    await fs.mkdirs(this.folder);
    await fs.mkdirs(this.outside);
    await fs.mkdirs(this.directory);
    await run(this, ["init", "--bare", "--quiet"]);
  });

  afterEach(async function () {
    await fs.remove(this.tmp);
  });

  // Runs git in the repository, resolving with its output as text
  function run(spec, args, input, env) {
    return new Promise(function (resolve, reject) {
      var child = execFile(
        "git",
        args,
        {
          cwd: spec.directory,
          env: Object.assign({}, process.env, { GIT_DIR: spec.directory }, IDENTITY, env),
          maxBuffer: 64 * 1024 * 1024,
        },
        function (err, stdout, stderr) {
          if (err) return reject(new Error(err.message + stderr));
          resolve(stdout.trim());
        }
      );

      // git may exit without reading its input
      child.stdin.on("error", function () {});
      child.stdin.end(input);
    });
  }

  function write(spec, contents) {
    return run(spec, ["hash-object", "-w", "--stdin"], contents);
  }

  function commitTree(spec, tree) {
    return run(spec, ["commit-tree", tree, "-m", "commit"].concat(spec.head ? ["-p", spec.head] : [])).then(
      function (commit) {
        spec.head = commit;
        return commit;
      }
    );
  }

  // Makes a commit on top of the last one made, from changes to its files:
  //
  //   { "a.txt": "contents", "gone.txt": null,
  //     "run.sh": { contents: "#!/bin/sh", mode: "100755" } }
  //
  // A directory in the way of a file, or the reverse, is replaced.
  async function commit(spec, changes) {
    // update-index wants a work tree, though it does not read it here
    var env = { GIT_INDEX_FILE: spec.index, GIT_WORK_TREE: spec.outside };

    for (var name of Object.keys(changes)) {
      var change = changes[name];

      if (change === null) {
        await run(spec, ["update-index", "--force-remove", "-z", "--stdin"], name + "\0", env);
        continue;
      }

      var mode = (change.mode) || "100644";
      var oid = await write(spec, change.contents === undefined ? change : change.contents);

      await run(
        spec,
        ["update-index", "--add", "--replace", "-z", "--index-info"],
        mode + " " + oid + "\t" + name + "\0",
        env
      );
    }

    return commitTree(spec, await run(spec, ["write-tree"], "", env));
  }

  // A commit of exactly the tree described, for names which `update-index`
  // refuses. A tree is { name: contents-or-tree }, names may be Buffers.
  async function commitExactly(spec, tree) {
    async function build(entries) {
      var records = [];

      for (var name of Object.keys(entries)) {
        var entry = entries[name];
        var isTree = typeof entry === "object" && !Buffer.isBuffer(entry);
        var oid = isTree ? await build(entry) : await write(spec, entry);

        records.push(Buffer.from((isTree ? "040000 tree " : "100644 blob ") + oid + "\t"));
        records.push(Buffer.from(name, "latin1"));
        records.push(Buffer.from([0]));
      }

      return run(spec, ["mktree", "-z"], Buffer.concat(records));
    }

    return commitTree(spec, await build(tree));
  }

  // Brings the folder from one commit to another, resolving with the paths
  function apply(spec, from, to) {
    return new Promise(function (resolve, reject) {
      var folder = {
        path: spec.folder,
        log: function (message) {
          spec.logs.push(message);
        },
      };

      materialize(spec.directory, folder, from, to, function (err, paths) {
        if (err) return reject(err);
        resolve(paths);
      });
    });
  }

  // Everything below a directory as { "relative/path": Buffer }, with its
  // directories as "relative/path/": true
  async function list(directory, prefix) {
    var found = {};

    prefix = prefix || "";

    for (var name of await fs.readdir(directory)) {
      var stat = await fs.lstat(path.join(directory, name));

      if (stat.isDirectory()) {
        found[prefix + name + "/"] = true;
        Object.assign(found, await list(path.join(directory, name), prefix + name + "/"));
      } else {
        found[prefix + name] = await fs.readFile(path.join(directory, name));
      }
    }

    return found;
  }

  it("writes the files of a first sync, from nothing", async function () {
    var first = await commit(this, {
      "a.txt": "A",
      "nested/deeper/b.txt": "B",
      "empty.txt": "",
    });

    expect(await apply(this, EMPTY_TREE, first)).toEqual([
      "a.txt",
      "empty.txt",
      "nested/deeper/b.txt",
    ]);
    expect(await list(this.folder)).toEqual({
      "a.txt": Buffer.from("A"),
      "empty.txt": Buffer.from(""),
      "nested/": true,
      "nested/deeper/": true,
      "nested/deeper/b.txt": Buffer.from("B"),
    });
  });

  it("writes nothing for an empty first sync", async function () {
    var first = await commit(this, {});

    expect(await apply(this, EMPTY_TREE, first)).toEqual([]);
    expect(await list(this.folder)).toEqual({});
  });

  it("touches only the paths that changed", async function () {
    var first = await commit(this, { "same.txt": "Same", "changed.txt": "Before" });

    await apply(this, EMPTY_TREE, first);

    // Changes made in the folder by something other than a sync are left,
    // however wrong they are: a resync repairs them
    await fs.writeFile(this.folder + "/same.txt", "Drifted");
    await fs.writeFile(this.folder + "/untracked.txt", "Not in the repository");

    var second = await commit(this, { "changed.txt": "After", "added.txt": "Added" });

    expect(await apply(this, first, second)).toEqual(["added.txt", "changed.txt"]);
    expect(await list(this.folder)).toEqual({
      "same.txt": Buffer.from("Drifted"),
      "untracked.txt": Buffer.from("Not in the repository"),
      "changed.txt": Buffer.from("After"),
      "added.txt": Buffer.from("Added"),
    });
  });

  it("removes deleted files and the directories they leave empty", async function () {
    var first = await commit(this, {
      "top/only/deep/file.txt": "Only",
      "top/sibling.txt": "Stays",
      "kept.txt": "Kept",
    });

    await apply(this, EMPTY_TREE, first);
    await fs.mkdirs(this.folder + "/was-already-empty");

    var second = await commit(this, { "top/only/deep/file.txt": null });

    expect(await apply(this, first, second)).toEqual(["top/only/deep/file.txt"]);
    expect(await list(this.folder)).toEqual({
      "top/": true,
      "top/sibling.txt": Buffer.from("Stays"),
      "kept.txt": Buffer.from("Kept"),
      "was-already-empty/": true,
    });
  });

  it("removes a symbolic link which was deleted from the repository", async function () {
    var first = await commit(this, {
      "kept.txt": "Kept",
      "link.txt": { contents: "kept.txt", mode: "120000" },
    });

    await apply(this, EMPTY_TREE, first);
    await fs.symlink("kept.txt", this.folder + "/link.txt");

    var second = await commit(this, { "link.txt": null });

    expect(await apply(this, first, second)).toEqual(["link.txt"]);
    expect(await list(this.folder)).toEqual({ "kept.txt": Buffer.from("Kept") });
  });

  it("applies a rename as a removal and a write", async function () {
    var first = await commit(this, { "old/name.txt": "Contents", "other.txt": "Other" });

    await apply(this, EMPTY_TREE, first);

    var second = await commit(this, { "old/name.txt": null, "new/name.txt": "Contents" });

    expect(await apply(this, first, second)).toEqual(["new/name.txt", "old/name.txt"]);
    expect(await list(this.folder)).toEqual({
      "new/": true,
      "new/name.txt": Buffer.from("Contents"),
      "other.txt": Buffer.from("Other"),
    });
  });

  it("replaces a file with a directory of the same name", async function () {
    var first = await commit(this, { swap: "A file" });

    await apply(this, EMPTY_TREE, first);

    var second = await commit(this, { swap: null, "swap/inner.txt": "In a directory" });

    await apply(this, first, second);

    expect(await list(this.folder)).toEqual({
      "swap/": true,
      "swap/inner.txt": Buffer.from("In a directory"),
    });
  });

  it("replaces a directory with a file of the same name", async function () {
    var first = await commit(this, { "swap/one.txt": "One", "swap/two/three.txt": "Three" });

    await apply(this, EMPTY_TREE, first);

    var second = await commit(this, {
      "swap/one.txt": null,
      "swap/two/three.txt": null,
      swap: "A file",
    });

    await apply(this, first, second);

    expect(await list(this.folder)).toEqual({ swap: Buffer.from("A file") });
  });

  it("handles a rename which only changes the case of the name", async function () {
    var first = await commit(this, { "Readme.txt": "Contents", "Dir/File.txt": "Nested" });

    await apply(this, EMPTY_TREE, first);

    var second = await commit(this, {
      "Readme.txt": null,
      "readme.txt": "Contents",
      "Dir/File.txt": null,
      "dir/file.txt": "Nested",
    });

    await apply(this, first, second);

    // On any filesystem the old names have to be gone before the new ones
    // are written
    expect(await fs.readdir(this.folder)).toEqual(["dir", "readme.txt"]);
    expect(await fs.readdir(this.folder + "/dir")).toEqual(["file.txt"]);
  });

  it("keeps non-ASCII names, names with spaces and names that need quoting", async function () {
    var names = {
      "日本語/こんにちは 世界.txt": "Japanese",
      "café/crème  brûlée.txt": "Accents and two spaces",
      "emoji 🎉/it's \"quoted\" $(echo).txt": "Emoji and quotes",
      "tab\tand\nnewline.txt": "Control characters",
    };
    var first = await commit(this, names);

    expect((await apply(this, EMPTY_TREE, first)).sort()).toEqual(Object.keys(names).sort());

    for (var name of Object.keys(names))
      expect(await fs.readFile(path.join(this.folder, name))).toEqual(Buffer.from(names[name]));
  });

  it("skips a name which is not valid UTF-8", async function () {
    var first = await commitExactly(this, { "b\xff.txt": "Not text", "fine.txt": "Fine" });

    expect(await apply(this, EMPTY_TREE, first)).toEqual(["fine.txt"]);
    expect(await list(this.folder)).toEqual({ "fine.txt": Buffer.from("Fine") });
    expect(this.logs.join("\n")).toContain("not safe to write");
  });

  it("sets the executable bit from the committed mode, and changes it", async function () {
    var first = await commit(this, {
      "run.sh": { contents: "#!/bin/sh\n", mode: "100755" },
      "plain.txt": "Plain",
    });

    await apply(this, EMPTY_TREE, first);

    expect((await fs.stat(this.folder + "/run.sh")).mode & 0o111).not.toBe(0);
    expect((await fs.stat(this.folder + "/plain.txt")).mode & 0o111).toBe(0);

    // Only the modes change, in both directions at once
    var second = await commit(this, {
      "run.sh": { contents: "#!/bin/sh\n", mode: "100644" },
      "plain.txt": { contents: "Plain", mode: "100755" },
    });

    expect(await apply(this, first, second)).toEqual(["plain.txt", "run.sh"]);
    expect((await fs.stat(this.folder + "/run.sh")).mode & 0o111).toBe(0);
    expect((await fs.stat(this.folder + "/plain.txt")).mode & 0o111).not.toBe(0);
    expect(await fs.readFile(this.folder + "/run.sh", "utf8")).toBe("#!/bin/sh\n");
  });

  it("writes the same blob to several paths", async function () {
    var first = await commit(this, { "one.txt": "Same", "two/copy.txt": "Same", "three.txt": "Same" });

    await apply(this, EMPTY_TREE, first);

    expect(await list(this.folder)).toEqual({
      "one.txt": Buffer.from("Same"),
      "two/": true,
      "two/copy.txt": Buffer.from("Same"),
      "three.txt": Buffer.from("Same"),
    });
  });

  it("writes a large file byte for byte, without holding it in memory", async function () {
    // Random data with NULs and newlines where a parser of cat-file's output
    // could be confused, and far more than a chunk. It ends in a newline too.
    var blob = Buffer.alloc(96 * 1024 * 1024);
    var block = crypto.randomBytes(1024 * 1024);

    block[0] = 0;
    block[1] = 10;
    block[block.length - 1] = 10;

    for (var offset = 0; offset < blob.length; offset += block.length) block.copy(blob, offset);

    var first = await commit(this, { "big.bin": blob, "after.txt": "After the large file" });
    var before = process.memoryUsage().rss;
    var peak = before;
    var timer = setInterval(function () {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 5);

    try {
      await apply(this, EMPTY_TREE, first);
    } finally {
      clearInterval(timer);
    }

    // Buffering the file would add at least its size
    expect(peak - before).toBeLessThan(blob.length / 2);
    expect(Buffer.compare(await fs.readFile(this.folder + "/big.bin"), blob)).toBe(0);
    expect(await fs.readFile(this.folder + "/after.txt", "utf8")).toBe("After the large file");
  }, 120 * 1000);

  describe("paths which are not safe", function () {
    it("never writes to or removes the folder's .git directory", async function () {
      await fs.outputFile(this.folder + "/.git/config", "The live clone's config");

      var first = await commitExactly(this, {
        ".git": { config: "Overwritten", hooks: { "post-checkout": "#!/bin/sh\n" } },
        ".GIT": { config: "Overwritten" },
        "fine.txt": "Fine",
      });

      expect(await apply(this, EMPTY_TREE, first)).toEqual(["fine.txt"]);

      var second = await commitExactly(this, { "fine.txt": "Fine" });

      expect(await apply(this, first, second)).toEqual([]);
      expect(await list(this.folder)).toEqual({
        ".git/": true,
        ".git/config": Buffer.from("The live clone's config"),
        "fine.txt": Buffer.from("Fine"),
      });
    });

    it("never writes outside the folder", async function () {
      var first = await commitExactly(this, {
        "..": { outside: { "pwned.txt": "Escaped" } },
        nested: { "..": { "pwned.txt": "Escaped" }, ".": { "pwned.txt": "Escaped" } },
        "fine.txt": "Fine",
      });

      expect(await apply(this, EMPTY_TREE, first)).toEqual(["fine.txt"]);
      expect(await list(this.tmp + "/outside")).toEqual({});
      expect(await fs.readdir(this.tmp)).not.toContain("pwned.txt");
      expect(await list(this.folder)).toEqual({ "fine.txt": Buffer.from("Fine") });
    });

    it("replaces a symbolic link in the way of a directory, without following it", async function () {
      await fs.symlink(this.outside, this.folder + "/linked");

      var first = await commit(this, { "linked/pwned.txt": "Escaped" });

      expect(await apply(this, EMPTY_TREE, first)).toEqual(["linked/pwned.txt"]);
      expect(await list(this.outside)).toEqual({});
      expect((await fs.lstat(this.folder + "/linked")).isDirectory()).toBe(true);
      expect(await fs.readFile(this.folder + "/linked/pwned.txt", "utf8")).toBe("Escaped");
    });

    it("replaces a symbolic link at the path of a file, without writing through it", async function () {
      await fs.writeFile(this.outside + "/victim.txt", "Untouched");
      await fs.symlink(this.outside + "/victim.txt", this.folder + "/file.txt");

      var first = await commit(this, { "file.txt": "Replaced" });

      await apply(this, EMPTY_TREE, first);

      expect(await fs.readFile(this.outside + "/victim.txt", "utf8")).toBe("Untouched");
      expect((await fs.lstat(this.folder + "/file.txt")).isFile()).toBe(true);
      expect(await fs.readFile(this.folder + "/file.txt", "utf8")).toBe("Replaced");
    });

    it("does not remove a file through a symbolic link to a directory", async function () {
      await fs.writeFile(this.outside + "/file.txt", "Untouched");

      var first = await commit(this, { "linked/file.txt": "In the repository" });
      var second = await commit(this, { "linked/file.txt": null });

      await fs.symlink(this.outside, this.folder + "/linked");
      await apply(this, first, second);

      expect(await fs.readFile(this.outside + "/file.txt", "utf8")).toBe("Untouched");
      expect((await fs.lstat(this.folder + "/linked")).isSymbolicLink()).toBe(true);
    });
  });

  async function failure(promise) {
    try {
      await promise;
    } catch (err) {
      return err;
    }
  }

  it("fails if the repository does not have a blob", async function () {
    var first = await commit(this, { "a.txt": "A", "b.txt": "B" });
    var oid = await write(this, "B");

    await fs.remove(this.directory + "/objects/" + oid.slice(0, 2) + "/" + oid.slice(2));

    var err = await failure(apply(this, EMPTY_TREE, first));

    expect(err.message).toContain(oid);
  });

  it("fails if a commit does not exist", async function () {
    var err = await failure(
      apply(this, EMPTY_TREE, "0123456789012345678901234567890123456789")
    );

    expect(err.message).toContain("diff-tree failed");
  });
});
