// IMPLEMENTATION-SPECIFIC. served/materialize.js brings a blog folder from one
// commit to another by reading the git store. The specs that go through a
// real git client and a sync are in sync-paths.js and sync-history.js; these
// call it directly, with history made by plumbing in a scratch repository and
// imported into a store, so that it can hold what a push is no longer allowed
// to: paths a real client would not send, and shapes that some filesystems
// cannot show at once (names that differ by case).
describe("git client: materialize", function () {
  // A real blog: materialize writes its folder through storage/folder, by
  // blog ID. this.folder is that folder on disk, for looking at the result.
  global.test.blog();

  var fs = require("fs-extra");
  var os = require("os");
  var crypto = require("crypto");
  var path = require("path");
  var { execFile } = require("child_process");
  var materialize = require("clients/git/served/materialize");
  var importRepo = require("clients/git/store/import");
  var { createCache, createMemoryStore, createFsStore, createReader, manifest } = require("clients/git/store");

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
    this.folder = this.blogDirectory;
    this.outside = this.tmp + "/outside";
    this.index = this.tmp + "/index";
    this.logs = [];
    this.head = null;

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

  // The repository's history in a store of its own: master at the last
  // commit made, which every commit made is an ancestor of
  async function load(spec, store) {
    if (spec.head) await run(spec, ["update-ref", "refs/heads/master", spec.head]);

    store = store || createMemoryStore();

    var cache = createCache({ dir: spec.tmp + "/cache-" + crypto.randomBytes(4).toString("hex"), maxBytes: 256 * 1024 * 1024 });

    if (spec.head) await importRepo({ store: store, cache: cache, lock: (fn) => fn(), gitDir: spec.directory, scratchDir: spec.tmp + "/scratch" });

    return { store: store, cache: cache };
  }

  // Brings the folder from one commit to another, resolving with the paths
  async function apply(spec, from, to) {
    var { store, cache } = await load(spec);
    var current = await manifest.read(store);
    var reader = createReader({ store: store, cache: cache, manifest: current, scratch: cache });

    return materialize({
      blogID: spec.blog.id,
      reader: reader,
      from: from,
      to: to,
      log: function (message) {
        spec.logs.push(message);
      },
    });
  }

  // What applying a commit adds to the resident memory of a node process which
  // does nothing else, at its peak. This process cannot measure it. Each chunk
  // read from the store is a Buffer outside the heap, and it stays resident,
  // though written and dead, until a GC. Once a long run has grown the young
  // generation only V8's 64 MiB limit on external memory prompts one, so here
  // that much garbage piles up or not depending on the specs that ran first. A
  // 1 MiB semi-space collects the chunks every few MiB, whatever the size of
  // the file. The store is a directory, which the child opens.
  var MEASURE_MEMORY = `
    var [materialize, store, directory, cacheDirectory, blogID, from, to] = process.argv.slice(1);
    var { createCache, createReader, createFsStore, manifest } = require(store);
    var objects = createFsStore({ root: directory });
    var cache = createCache({ dir: cacheDirectory, maxBytes: 256 * 1024 * 1024 });

    manifest.read(objects).then(function (current) {
      var reader = createReader({ store: objects, cache: cache, manifest: current, scratch: cache });
      var before = process.memoryUsage().rss;
      var peak = before;
      var timer = setInterval(function () {
        peak = Math.max(peak, process.memoryUsage().rss);
      }, 5);

      return require(materialize)({ blogID: blogID, reader: reader, from: from, to: to }).then(function () {
        clearInterval(timer);
        console.log(peak - before);
      });
    }).catch(function (err) {
      console.error(err);
      process.exit(1);
    });
  `;

  async function memoryGrowth(spec, from, to) {
    var directory = spec.tmp + "/fs-store";

    await load(spec, createFsStore({ root: directory }));

    return new Promise(function (resolve, reject) {
      execFile(
        process.execPath,
        [
          "--max-semi-space-size=1",
          "-e",
          MEASURE_MEMORY,
          require.resolve("clients/git/served/materialize"),
          path.dirname(require.resolve("clients/git/store")),
          directory,
          spec.tmp + "/child-cache",
          spec.blog.id,
          from,
          to,
        ],
        function (err, stdout, stderr) {
          if (err) return reject(new Error(err.message + stderr));
          resolve(Number(stdout));
        }
      );
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

    expect((await apply(this, first, second)).sort()).toEqual(["added.txt", "changed.txt"]);
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

  it("applies a rename", async function () {
    var first = await commit(this, { "old/name.txt": "Contents", "other.txt": "Other" });

    await apply(this, EMPTY_TREE, first);

    var second = await commit(this, { "old/name.txt": null, "new/name.txt": "Contents" });

    expect((await apply(this, first, second)).sort()).toEqual(["new/name.txt", "old/name.txt"]);
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

  // The blog folder has no executable bit (storage/folder), so an executable
  // file is written like any other, and a change of mode alone rewrites it
  it("writes executable files, and passes on a change of mode alone", async function () {
    var first = await commit(this, {
      "run.sh": { contents: "#!/bin/sh\n", mode: "100755" },
      "plain.txt": "Plain",
    });

    expect(await apply(this, EMPTY_TREE, first)).toEqual(["plain.txt", "run.sh"]);
    expect(await list(this.folder)).toEqual({
      "plain.txt": Buffer.from("Plain"),
      "run.sh": Buffer.from("#!/bin/sh\n"),
    });

    // Only the modes change, in both directions at once
    var second = await commit(this, {
      "run.sh": { contents: "#!/bin/sh\n", mode: "100644" },
      "plain.txt": { contents: "Plain", mode: "100755" },
    });

    expect(await apply(this, first, second)).toEqual(["plain.txt", "run.sh"]);
    expect(await list(this.folder)).toEqual({
      "plain.txt": Buffer.from("Plain"),
      "run.sh": Buffer.from("#!/bin/sh\n"),
    });
  });

  // storage/folder names files in NFC. A name committed in NFD is written
  // under its NFC name, and a later change, rename or removal of that NFD
  // name in git acts on the same file, leaving nothing behind.
  describe("a name which is not in NFC", function () {
    var nfd = "cafe\u0301";
    var nfc = nfd.normalize("NFC");

    it("is written, changed and removed under its NFC name", async function () {
      expect(nfd).not.toBe(nfc);

      var first = await commit(this, { [nfd + "/" + nfd + ".txt"]: "First", "kept.txt": "Kept" });

      // In git's order, by the committed bytes
      expect(await apply(this, EMPTY_TREE, first)).toEqual([nfc + "/" + nfc + ".txt", "kept.txt"]);

      // Names as they are on disk: only the NFC spelling is there
      expect((await fs.readdir(this.folder)).sort()).toEqual(["kept.txt", nfc].sort());
      expect(await fs.readdir(this.folder + "/" + nfc)).toEqual([nfc + ".txt"]);
      expect(await fs.readFile(this.folder + "/" + nfc + "/" + nfc + ".txt", "utf8")).toBe("First");

      var second = await commit(this, { [nfd + "/" + nfd + ".txt"]: "Second" });

      expect(await apply(this, first, second)).toEqual([nfc + "/" + nfc + ".txt"]);
      expect(await list(this.folder)).toEqual({
        "kept.txt": Buffer.from("Kept"),
        [nfc + "/"]: true,
        [nfc + "/" + nfc + ".txt"]: Buffer.from("Second"),
      });

      var third = await commit(this, { [nfd + "/" + nfd + ".txt"]: null });

      expect(await apply(this, second, third)).toEqual([nfc + "/" + nfc + ".txt"]);
      expect(await list(this.folder)).toEqual({ "kept.txt": Buffer.from("Kept") });
    });

    it("is renamed to its NFC form without losing the file", async function () {
      var first = await commit(this, { [nfd + ".txt"]: "Contents" });

      await apply(this, EMPTY_TREE, first);

      // The removal of the NFD name comes first, then the write of the NFC one
      var second = await commit(this, { [nfd + ".txt"]: null, [nfc + ".txt"]: "Contents" });

      await apply(this, first, second);

      expect(await list(this.folder)).toEqual({ [nfc + ".txt"]: Buffer.from("Contents") });

      var third = await commit(this, { [nfc + ".txt"]: null });

      await apply(this, second, third);

      expect(await list(this.folder)).toEqual({});
    });
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
    var growth = await memoryGrowth(this, EMPTY_TREE, first);

    // Buffering the file would add at least its size
    expect(growth).toBeLessThan(blob.length / 2);
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
      expect(await fs.readdir(path.dirname(this.folder))).not.toContain("pwned.txt");
      expect(await fs.readdir(path.dirname(this.folder))).not.toContain("outside");
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

  it("fails if the store does not have a commit", async function () {
    await commit(this, { "a.txt": "A" });

    var err = await failure(apply(this, EMPTY_TREE, "0123456789012345678901234567890123456789"));

    expect(err).toEqual(jasmine.any(Error));
    expect(err.code).toBe("NOT_FOUND");
  });
});
