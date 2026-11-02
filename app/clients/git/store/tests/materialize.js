// Brings folders from one commit to another from packs in an object store, and
// compares the result with what `git checkout` and `git diff-tree` say it
// should be. The history is made by plumbing so that it can hold what a push is
// no longer allowed to: paths a real client would not send, links, submodules.
// The same cases are run against the materializer on EBS in
// app/clients/git/tests/materialize.js, and the two have to agree.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { execFile } = require("child_process");
const timeout = require("./helpers/timeout");
const faults = require("./helpers/faults");
const fx = require("./helpers/fixture");
const { makeRepo, listFiles } = require("./helpers/repo");
const createMemoryStore = require("../objectStore/memory");
const createCache = require("../cache");
const createReader = require("../reader");
const materialize = require("../materialize");
const createFolderSink = require("../folderSink");
const { TooLargeError, CorruptError, NotFoundError } = require("../errors");

describe("git store materialize", function () {
  timeout(120 * 1000);

  let repo;
  let tmp;
  let folder;
  let outside;
  let logs;

  beforeEach(function () {
    repo = makeRepo();
    tmp = fx.tempDir();
    folder = path.join(tmp, "folder");
    outside = path.join(tmp, "outside");
    logs = [];
    fs.mkdirSync(folder);
    fs.mkdirSync(outside);
  });

  afterEach(function () {
    repo.remove();
    fx.remove(tmp);
  });

  // The bytes of a UTF-8 name, as the latin1 text commitExactly takes
  const raw = (name) => Buffer.from(name).toString("latin1");

  async function apply(reader, from, to, options = {}) {
    return materialize({
      reader,
      from,
      to,
      sink: createFolderSink({ root: folder }),
      log: (message) => logs.push(message),
      ...options,
    });
  }

  // Applies each commit in turn, and after each the folder must be exactly
  // what a checkout of that commit is
  async function expectCheckouts(commits, options) {
    const { reader } = await repo.reader(options);
    let previous = null;

    for (const commit of commits) {
      await apply(reader, previous, commit);
      expect(listFiles(folder)).toEqual(repo.checkout(commit));
      previous = commit;
    }
    return reader;
  }

  // The expected counts for a range, from git diff-tree
  function expectedCounts(from, to) {
    const changes = repo.diffTree(from && repo.treeOf(from), to && repo.treeOf(to));
    const written = changes.filter((c) => c.newMode === "100644" || c.newMode === "100755").length;
    return { written, removed: changes.length - written, skipped: 0 };
  }

  describe("against git checkout", function () {
    it("writes the files of a first sync, from nothing, and nothing for an empty tree", async function () {
      const first = repo.commit({ "a.txt": "A", "nested/deeper/b.txt": "B", "empty.txt": "" });
      const { reader } = await repo.reader();

      expect(await apply(reader, null, first)).toEqual({ written: 3, removed: 0, skipped: 0 });
      expect(listFiles(folder)).toEqual(repo.checkout(first));
      expect(listFiles(folder)["empty.txt"].contents.length).toBe(0);

      // To nothing, and the directories go too
      expect(await apply(reader, first, null)).toEqual({ written: 0, removed: 3, skipped: 0 });
      expect(listFiles(folder)).toEqual({});
      expect(await apply(reader, null, null)).toEqual({ written: 0, removed: 0, skipped: 0 });
    });

    it("follows a history of additions, edits, removals, renames and mode changes", async function () {
      const commits = [
        repo.commit({ "a.txt": "A", "same.txt": "Same", "old/name.txt": "Contents", "run.sh": { contents: "#!/bin/sh\n", mode: "100755" } }),
        repo.commit({ "a.txt": "A, edited", "added/deep/er.txt": "New" }),
        repo.commit({ "old/name.txt": null, "new/name.txt": "Contents" }),
        repo.commit({ "run.sh": { contents: "#!/bin/sh\n", mode: "100644" }, "a.txt": { contents: "A, edited", mode: "100755" } }),
        repo.commit({ "added/deep/er.txt": null, "a.txt": null }),
      ];
      const reader = await expectCheckouts(commits);

      // Counts are those of git diff-tree
      await apply(reader, null, commits[0]);
      for (let i = 1; i < commits.length; i++) {
        expect(await apply(reader, commits[i - 1], commits[i])).toEqual(expectedCounts(commits[i - 1], commits[i]));
      }
    });

    it("removes the directories a removal leaves empty, and no others", async function () {
      const first = repo.commit({ "top/only/deep/file.txt": "Only", "top/sibling.txt": "Stays", "kept.txt": "Kept" });
      const second = repo.commit({ "top/only/deep/file.txt": null });
      const { reader } = await repo.reader();

      await apply(reader, null, first);
      fs.mkdirSync(path.join(folder, "was-already-empty"));
      await apply(reader, first, second);

      expect(listFiles(folder)).toEqual({ ...repo.checkout(second), "was-already-empty/": true });
    });

    it("touches only the paths that changed", async function () {
      const first = repo.commit({ "same.txt": "Same", "changed.txt": "Before" });
      const second = repo.commit({ "changed.txt": "After", "added.txt": "Added" });
      const { reader } = await repo.reader();

      await apply(reader, null, first);
      fs.writeFileSync(path.join(folder, "same.txt"), "Drifted");
      fs.writeFileSync(path.join(folder, "untracked.txt"), "Not in the repository");

      await apply(reader, first, second);

      expect(fs.readFileSync(path.join(folder, "same.txt"), "utf8")).toBe("Drifted");
      expect(fs.readFileSync(path.join(folder, "untracked.txt"), "utf8")).toBe("Not in the repository");
      expect(fs.readFileSync(path.join(folder, "changed.txt"), "utf8")).toBe("After");
      expect(fs.readFileSync(path.join(folder, "added.txt"), "utf8")).toBe("Added");
    });

    it("replaces a file with a directory of the same name, and the reverse", async function () {
      const commits = [
        repo.commit({ swap: "A file", "other/one.txt": "One", "other/two/three.txt": "Three" }),
        repo.commit({ swap: null, "swap/inner.txt": "In a directory" }),
        repo.commit({ "swap/inner.txt": null, swap: "A file again", "other/one.txt": null, "other/two/three.txt": null, other: "A file" }),
        repo.commit({ other: null, "other/back.txt": "Back" }),
      ];

      await expectCheckouts(commits);
      await expectCheckouts(commits.slice().reverse().slice(0, 2).reverse());
    });

    it("handles names which differ only by case, as different names", async function () {
      const commits = [
        repo.commit({ "Readme.txt": "Contents", "Dir/File.txt": "Nested" }),
        repo.commit({ "Readme.txt": null, "readme.txt": "Contents", "Dir/File.txt": null, "dir/file.txt": "Nested" }),
        repo.commit({ "readme.txt": null, "Readme.txt": "Contents", "dir/file.txt": null, "Dir/File.txt": "Nested" }),
      ];

      await expectCheckouts(commits);
    });

    it("writes one blob to several paths", async function () {
      const first = repo.commit({ "one.txt": "Same", "two/copy.txt": "Same", "three.txt": "Same" });

      await expectCheckouts([first]);
    });

    it("keeps non-ASCII names, names with spaces and names that need quoting", async function () {
      const first = repo.commit({
        "日本語/こんにちは 世界.txt": "Japanese",
        "café/crème  brûlée.txt": "Accents and two spaces",
        "emoji 🎉/it's \"quoted\" $(echo).txt": "Emoji and quotes",
        "tab\tand\nnewline.txt": "Control characters",
      });

      await expectCheckouts([first]);
    });

    it("keeps a name exactly as committed, in NFC or NFD, and never normalizes", async function () {
      // On a filesystem which treats the two as one name only one would
      // survive; the folder here (and Blot's) does not
      const nfc = "café";
      const nfd = "café";
      const first = repo.commitExactly({
        [raw("nfc-" + nfc)]: { "a.txt": "NFC directory" },
        [raw("nfd-" + nfd)]: { "a.txt": "NFD directory" },
        [raw(nfc + ".txt")]: "NFC file",
        [raw(nfd + "-2.txt")]: "NFD file",
      });
      const { reader } = await repo.reader();

      await apply(reader, null, first);

      const names = fs.readdirSync(folder);
      expect(names).toContain("nfc-" + nfc);
      expect(names).toContain("nfd-" + nfd);
      expect(names).toContain(nfc + ".txt");
      expect(names).toContain(nfd + "-2.txt");
      expect(listFiles(folder)).toEqual(repo.checkout(first));
    });

    it("writes the raw bytes, whatever they are", async function () {
      const bytes = Buffer.concat([
        Buffer.from([0, 10, 13, 10, 255, 0, 0]),
        crypto.randomBytes(200 * 1024),
        Buffer.from("line one\r\nline two\r\n$Id$ \n"),
      ]);
      const first = repo.commit({
        "bytes.bin": bytes,
        "crlf.txt": "one\r\ntwo\r\n",
        ".gitattributes": "*.txt eol=lf\ncrlf.txt ident\n",
        ".gitignore": "*\n",
      });
      const { reader } = await repo.reader();

      await apply(reader, null, first);

      expect(fs.readFileSync(path.join(folder, "bytes.bin")).equals(bytes)).toBe(true);
      expect(fs.readFileSync(path.join(folder, "crlf.txt"), "utf8")).toBe("one\r\ntwo\r\n");
    });

    it("sets the executable bit from the committed mode, and changes it", async function () {
      const first = repo.commit({ "run.sh": { contents: "#!/bin/sh\n", mode: "100755" }, "plain.txt": "Plain" });
      const second = repo.commit({ "run.sh": { contents: "#!/bin/sh\n", mode: "100644" }, "plain.txt": { contents: "Plain", mode: "100755" } });
      const { reader } = await repo.reader();

      await apply(reader, null, first);
      expect(fs.statSync(path.join(folder, "run.sh")).mode & 0o111).not.toBe(0);
      expect(fs.statSync(path.join(folder, "plain.txt")).mode & 0o111).toBe(0);

      // Only the modes change, in both directions at once
      expect(await apply(reader, first, second)).toEqual({ written: 2, removed: 0, skipped: 0 });
      expect(fs.statSync(path.join(folder, "run.sh")).mode & 0o111).toBe(0);
      expect(fs.statSync(path.join(folder, "plain.txt")).mode & 0o111).not.toBe(0);
      expect(listFiles(folder)).toEqual(repo.checkout(second));
    });

    it("reads the same with OFS_DELTA and REF_DELTA packs", async function () {
      const lines = (n) => Array.from({ length: 300 }, (_, i) => "line " + i + (i % 50 === n ? " edited " + n : "")).join("\n") + "\n";
      const commits = [];
      for (let n = 0; n < 8; n++) commits.push(repo.commit({ "doc.txt": lines(n), ["post-" + n + ".txt"]: lines(n + 100) }));

      await expectCheckouts(commits);
      fs.rmSync(folder, { recursive: true });
      fs.mkdirSync(folder);
      await expectCheckouts(commits, { refDeltas: true });
    });
  });

  describe("paths which are not safe", function () {
    it("never writes to or removes the folder's .git directory", async function () {
      fs.mkdirSync(path.join(folder, ".git"));
      fs.writeFileSync(path.join(folder, ".git", "config"), "The live clone's config");

      const first = repo.commitExactly({
        ".git": { config: "Overwritten", hooks: { "post-checkout": "#!/bin/sh\n" } },
        ".GIT": { config: "Overwritten" },
        sub: { ".Git": { config: "Overwritten" } },
        "fine.txt": "Fine",
      });
      const second = repo.commitExactly({ "fine.txt": "Fine" });
      const { reader } = await repo.reader();

      expect(await apply(reader, null, first)).toEqual({ written: 1, removed: 0, skipped: 4 });
      expect(await apply(reader, first, second)).toEqual({ written: 0, removed: 0, skipped: 4 });
      expect(listFiles(folder)).toEqual({
        ".git/config": { contents: Buffer.from("The live clone's config"), mode: "644" },
        "fine.txt": { contents: Buffer.from("Fine"), mode: "644" },
      });
      expect(logs.join("\n")).toContain("not safe to write");
    });

    it("never writes outside the folder", async function () {
      const first = repo.commitExactly({
        "..": { outside: { "pwned.txt": "Escaped" } },
        nested: { "..": { "pwned.txt": "Escaped" }, ".": { "pwned.txt": "Escaped" } },
        "fine.txt": "Fine",
      });
      const { reader } = await repo.reader();

      expect(await apply(reader, null, first)).toEqual({ written: 1, removed: 0, skipped: 3 });
      expect(listFiles(outside)).toEqual({});
      expect(fs.readdirSync(tmp).sort()).toEqual(["folder", "outside"]);
      expect(Object.keys(listFiles(folder))).toEqual(["fine.txt"]);
    });

    it("cleans up the empty directories on a re-run, if a removal failed after the file went", async function () {
      const first = repo.commit({ "top/only/deep/file.txt": "Only", "kept.txt": "Kept" });
      const second = repo.commit({ "top/only/deep/file.txt": null });
      const { reader } = await repo.reader();

      await apply(reader, null, first);

      // The file is unlinked, then the first rmdir fails
      const original = fs.promises.rmdir;
      let failed = false;
      spyOn(fs.promises, "rmdir").and.callFake(async (...args) => {
        if (failed) return original(...args);
        failed = true;
        throw Object.assign(new Error("EIO"), { code: "EIO" });
      });

      let error;
      try {
        await apply(reader, first, second);
      } catch (err) {
        error = err;
      }
      expect(error && error.code).toBe("EIO");
      expect(fs.existsSync(path.join(folder, "top/only/deep"))).toBe(true);

      // The same range again finds the file gone and still removes them
      await apply(reader, first, second);
      expect(listFiles(folder)).toEqual(repo.checkout(second));
    });

    it("refuses an unsafe path itself if a sink is given one", async function () {
      const sink = createFolderSink({ root: folder });

      for (const bad of ["../x", "a/../x", "/abs", ".git/x", "a//b", "a/.GIT/b", ""]) {
        let error;
        try {
          await sink.write(bad, require("stream").Readable.from([Buffer.from("x")]), { mode: 0o644, size: 1 });
        } catch (err) {
          error = err;
        }
        expect(error && error.message).toContain("Not a safe path");
      }
      expect(fs.readdirSync(tmp).sort()).toEqual(["folder", "outside"]);
    });

    it("skips a name which is not valid UTF-8, and tells which", async function () {
      const first = repo.commitExactly({ "b\xff.txt": "Not text", dir: { "c\xfe": "Nor this" }, "fine.txt": "Fine" });
      const { reader } = await repo.reader();

      expect(await apply(reader, null, first)).toEqual({ written: 1, removed: 0, skipped: 2 });
      expect(Object.keys(listFiles(folder))).toEqual(["fine.txt"]);
      expect(logs.join("\n")).toContain("not safe to write");
    });

    it("replaces a symbolic link in the way of a directory, without following it", async function () {
      fs.symlinkSync(outside, path.join(folder, "linked"));

      const first = repo.commit({ "linked/pwned.txt": "Escaped", "linked/two.txt": "Two" });
      const { reader } = await repo.reader();

      expect(await apply(reader, null, first)).toEqual({ written: 2, removed: 0, skipped: 0 });
      expect(listFiles(outside)).toEqual({});
      expect(fs.lstatSync(path.join(folder, "linked")).isDirectory()).toBe(true);
      expect(fs.readFileSync(path.join(folder, "linked/pwned.txt"), "utf8")).toBe("Escaped");
    });

    it("replaces a symbolic link at the path of a file, without writing through it", async function () {
      fs.writeFileSync(path.join(outside, "victim.txt"), "Untouched");
      fs.symlinkSync(path.join(outside, "victim.txt"), path.join(folder, "file.txt"));

      const first = repo.commit({ "file.txt": "Replaced" });
      const { reader } = await repo.reader();

      await apply(reader, null, first);

      expect(fs.readFileSync(path.join(outside, "victim.txt"), "utf8")).toBe("Untouched");
      expect(fs.lstatSync(path.join(folder, "file.txt")).isFile()).toBe(true);
      expect(fs.readFileSync(path.join(folder, "file.txt"), "utf8")).toBe("Replaced");
    });

    it("does not remove a file through a symbolic link to a directory", async function () {
      fs.writeFileSync(path.join(outside, "file.txt"), "Untouched");

      const first = repo.commit({ "linked/file.txt": "In the repository" });
      const second = repo.commit({ "linked/file.txt": null });
      const { reader } = await repo.reader();

      fs.symlinkSync(outside, path.join(folder, "linked"));
      await apply(reader, first, second);

      expect(fs.readFileSync(path.join(outside, "file.txt"), "utf8")).toBe("Untouched");
      expect(fs.lstatSync(path.join(folder, "linked")).isSymbolicLink()).toBe(true);
    });
  });

  describe("links, submodules and other modes", function () {
    it("does not write a symbolic link, and removes one which was deleted", async function () {
      const first = repo.commit({ "kept.txt": "Kept", "link.txt": { contents: "kept.txt", mode: "120000" } });
      const second = repo.commit({ "link.txt": null });
      const { reader } = await repo.reader();

      expect(await apply(reader, null, first)).toEqual({ written: 1, removed: 0, skipped: 1 });
      expect(Object.keys(listFiles(folder))).toEqual(["kept.txt"]);

      // One that was there from before is removed
      fs.symlinkSync("kept.txt", path.join(folder, "link.txt"));
      expect(await apply(reader, first, second)).toEqual({ written: 0, removed: 1, skipped: 0 });
      expect(Object.keys(listFiles(folder))).toEqual(["kept.txt"]);
    });

    it("removes the file a link replaced, and writes a file where a link was", async function () {
      const commits = [
        repo.commit({ "x.txt": "A file" }),
        repo.commit({ "x.txt": { contents: "elsewhere", mode: "120000" } }),
        repo.commit({ "x.txt": "A file again" }),
      ];
      const { reader } = await repo.reader();

      await apply(reader, null, commits[0]);
      expect(await apply(reader, commits[0], commits[1])).toEqual({ written: 0, removed: 1, skipped: 0 });
      expect(listFiles(folder)).toEqual({});
      await apply(reader, commits[1], commits[2]);
      expect(listFiles(folder)).toEqual(repo.checkout(commits[2]));
    });

    it("writes a symbolic link only when asked to", async function () {
      const first = repo.commit({ "link.txt": { contents: "kept.txt", mode: "120000" }, "kept.txt": "Kept" });
      const { reader } = await repo.reader();

      expect(await apply(reader, null, first, { symlinks: true })).toEqual({ written: 2, removed: 0, skipped: 0 });
      expect(listFiles(folder)).toEqual(repo.checkout(first));
    });

    it("skips a submodule, and removes a file it replaced", async function () {
      const first = repo.commitExactly({ "fine.txt": "Fine", replaced: "A file" });
      const second = repo.commitExactly({
        "fine.txt": "Fine",
        replaced: { oid: "0123456789012345678901234567890123456789", mode: "160000" },
        module: { oid: "0123456789012345678901234567890123456789", mode: "160000" },
      });
      const { reader } = await repo.reader();

      await apply(reader, null, first);
      expect(await apply(reader, first, second)).toEqual({ written: 0, removed: 1, skipped: 1 });
      expect(Object.keys(listFiles(folder))).toEqual(["fine.txt"]);
    });

    it("skips a mode that is neither 100644 nor 100755", async function () {
      const first = repo.commitExactly({ odd: { contents: "Odd", mode: "100664" }, "fine.txt": "Fine" });
      const { reader } = await repo.reader();

      expect(await apply(reader, null, first)).toEqual({ written: 1, removed: 0, skipped: 1 });
      expect(Object.keys(listFiles(folder))).toEqual(["fine.txt"]);
    });
  });

  describe("failures", function () {
    async function failure(promise) {
      try {
        await promise;
      } catch (err) {
        return err;
      }
    }

    // A history of enough files for a failure to land in the middle
    function manyFiles() {
      const first = {};
      const second = {};
      for (let i = 0; i < 40; i++) {
        first["dir" + (i % 5) + "/file-" + i + ".txt"] = "First " + i + "\n".repeat(i);
        second["dir" + (i % 5) + "/file-" + i + ".txt"] = i % 3 ? "Second " + i : null;
      }
      return [repo.commit(first), repo.commit({ ...second, "added/new.txt": "New", "dir0": null, "dir0/replaced.txt": "A dir again" })];
    }

    it("fails clearly if a blob is not in the repository", async function () {
      const first = repo.commit({ "a.txt": "A", "b.txt": "B" });
      const { reader } = await repo.reader();
      const oid = repo.git(["hash-object", "--stdin"], "B");

      // A reader whose packs do not have the blob
      const missing = Object.assign(Object.create(reader), { stream: (id, o) => (id === oid ? null : reader.stream(id, o)) });
      const err = await failure(apply(missing, null, first));

      expect(err instanceof NotFoundError).toBe(true);
      expect(err.message).toContain(oid);
    });

    it("fails if a commit does not exist, or is not a commit", async function () {
      const first = repo.commit({ "a.txt": "A" });
      const { reader } = await repo.reader();

      expect((await failure(apply(reader, null, "0123456789012345678901234567890123456789"))) instanceof NotFoundError).toBe(true);
      expect((await failure(apply(reader, null, repo.treeOf(first)))) instanceof CorruptError).toBe(true);
    });

    it("never publishes a file whose bytes fail their check at the end of the stream", async function () {
      const first = repo.commit({ "a.txt": "A".repeat(5000), "b.txt": "B".repeat(5000) });
      const { reader } = await repo.reader();

      // What the reader does for a blob which is not the blob it was asked for:
      // the chunks arrive, and the iteration throws at its end
      const bad = Object.assign(Object.create(reader), {
        stream: async (id, o) => {
          const blob = await reader.stream(id, o);
          return {
            ...blob,
            data: (async function* () {
              yield* blob.data;
              throw new CorruptError("Object " + id + " read back as a different object");
            })(),
          };
        },
      });
      const err = await failure(apply(bad, null, first));

      expect(err instanceof CorruptError).toBe(true);
      // Nothing under the real name, and no temporary file left behind
      expect(fs.readdirSync(folder)).toEqual([]);
    });

    it("fails with the path for a blob stored as a delta that is over the limit, and writes nothing for it", async function () {
      const lines = (n) => Array.from({ length: 2000 }, (_, i) => "line " + i + (i % 100 === n ? " edited " + n : "")).join("\n") + "\n";
      const commits = [];
      for (let n = 0; n < 6; n++) commits.push(repo.commit({ "big.txt": lines(n) }));

      const { reader, packs } = await repo.reader({ maxSize: 1024 * 1024 });
      const entries = fx.listEntries(packs[0]);
      const blobOids = commits.map((c) => repo.git(["rev-parse", c + ":big.txt"]));
      const stored = blobOids.map((oid) => entries.find((e) => e.oid === oid));
      const deltaAt = stored.findIndex((e) => e.depth > 0);

      expect(deltaAt).toBeGreaterThan(-1);

      // A cap lower than the blob: whole objects still stream, deltas can't
      const small = (await repo.reader({ maxSize: 1000 })).reader;
      const err = await failure(apply(small, null, commits[deltaAt]));

      expect(err instanceof TooLargeError).toBe(true);
      expect(err.message).toContain("big.txt");
      expect(err.message).toContain(blobOids[deltaAt]);
      expect(fs.readdirSync(folder)).toEqual([]);

      // A whole object of the same size is fine at the same cap
      const whole = stored.findIndex((e) => e.depth === 0);
      await apply(small, null, commits[whole]);
      expect(fs.readFileSync(path.join(folder, "big.txt"), "utf8")).toBe(lines(whole));

      // And with room, the delta is written
      fs.rmSync(path.join(folder, "big.txt"));
      await apply(reader, null, commits[deltaAt]);
      expect(fs.readFileSync(path.join(folder, "big.txt"), "utf8")).toBe(lines(deltaAt));
    });

    it("ends correct when the same range is run again after a read failed part way", async function () {
      const [first, second] = manyFiles();
      const store = faults(createMemoryStore());
      const { reader } = await repo.reader({ store });

      for (const concurrency of [1, 4]) {
        // The folder as it was at the first commit, then one read fails on the
        // way to the second
        fs.rmSync(folder, { recursive: true });
        fs.mkdirSync(folder);
        await apply(reader, null, first);
        expect(listFiles(folder)).toEqual(repo.checkout(first));

        store.inject("read", { key: /\.pack$/, skip: 25, before: new Error("connection reset") });

        const err = await failure(apply(reader, first, second, { concurrency }));
        expect(err.message).toBe("connection reset");
        expect(store.pending()).toBe(0);

        // The host runs the same range again
        await apply(reader, first, second, { concurrency });
        expect(listFiles(folder)).toEqual(repo.checkout(second));

        // And again, which changes nothing
        await apply(reader, first, second, { concurrency });
        expect(listFiles(folder)).toEqual(repo.checkout(second));
      }
    });

    it("ends correct when the same range is run again after the sink failed part way", async function () {
      const [first, second] = manyFiles();
      const { reader } = await repo.reader();

      for (const [operation, after] of [["write", 5], ["remove", 3]]) {
        fs.rmSync(folder, { recursive: true });
        fs.mkdirSync(folder);
        await apply(reader, null, first);

        const real = createFolderSink({ root: folder });
        let calls = 0;
        const failing = {
          ...real,
          [operation]: async (...args) => {
            if (++calls > after) throw new Error("disk full");
            return real[operation](...args);
          },
        };

        const err = await failure(materialize({ reader, from: first, to: second, sink: failing, concurrency: 3 }));
        expect(err.message).toBe("disk full");
        expect(listFiles(folder)).not.toEqual(repo.checkout(second));

        await apply(reader, first, second);
        expect(listFiles(folder)).toEqual(repo.checkout(second));
      }
    });

    it("stops starting work after a failure, and waits for what is running", async function () {
      const [first] = manyFiles();
      const { reader } = await repo.reader();
      const real = createFolderSink({ root: folder });
      let active = 0;
      let started = 0;
      const sink = {
        ...real,
        write: async (...args) => {
          const mine = ++started;
          active++;
          await new Promise((resolve) => setTimeout(resolve, 5));
          active--;
          if (mine === 3) throw new Error("boom");
          return real.write(...args);
        },
      };

      const err = await failure(materialize({ reader, from: null, to: first, sink, concurrency: 2 }));

      expect(err.message).toBe("boom");
      expect(active).toBe(0);
      expect(started).toBeLessThan(10);
    });

    it("never runs a removal with a write in flight, or a write with a removal in flight", async function () {
      const commits = [
        repo.commit({ "Readme.txt": "R", "Dir/File.txt": "F", "x/a.txt": "A", "x/b.txt": "B", "y": "A file" }),
        repo.commit({ "Readme.txt": null, "readme.txt": "R", "Dir/File.txt": null, "dir/file.txt": "F", "x/a.txt": null, "x/c.txt": "C", y: null, "y/z.txt": "Z" }),
      ];
      const { reader } = await repo.reader();
      const real = createFolderSink({ root: folder });
      const running = { write: 0, remove: 0 };
      const clashes = [];
      const wrap = (operation, other) => async (...args) => {
        running[operation]++;
        if (running[other]) clashes.push(operation + " " + args[0]);
        await new Promise((resolve) => setTimeout(resolve, 3));
        try {
          return await real[operation](...args);
        } finally {
          running[operation]--;
        }
      };
      const sink = { ...real, write: wrap("write", "remove"), remove: wrap("remove", "write") };

      await materialize({ reader, from: null, to: commits[0], sink, concurrency: 8 });
      await materialize({ reader, from: commits[0], to: commits[1], sink, concurrency: 8 });

      expect(clashes).toEqual([]);
      expect(listFiles(folder)).toEqual(repo.checkout(commits[1]));
    });
  });

  describe("memory", function () {
    // How much the resident memory of a process grows applying a commit, at
    // its peak (see helpers/measureMaterialize.js)
    function memoryGrowth(packDir, from, to) {
      return new Promise((resolve, reject) => {
        execFile(
          process.execPath,
          ["--expose-gc", path.join(__dirname, "helpers/measureMaterialize.js"), packDir, folder, String(from), to],
          function (err, stdout, stderr) {
            if (err) return reject(new Error(err.message + stderr));
            resolve(Number(stdout));
          }
        );
      });
    }

    it("streams a large blob byte for byte, without holding it in memory", async function () {
      // Random data with NULs and newlines where a parser could be confused,
      // and far more than a chunk. It ends in a newline too.
      const blob = Buffer.alloc(48 * 1024 * 1024);
      const block = crypto.randomBytes(1024 * 1024);

      block[0] = 0;
      block[1] = 10;
      block[block.length - 1] = 10;

      for (let offset = 0; offset < blob.length; offset += block.length) block.copy(blob, offset);

      const first = repo.commit({ "big.bin": blob, "after.txt": "After the large file" });
      const { packs } = await repo.reader();

      expect(packs.length).toBe(1);

      const growth = await memoryGrowth(path.join(repo.dir, "objects", "pack"), null, first);

      // Buffering the file would add at least its size. Streaming holds a few
      // megabytes (it was 2 to 10 for 8 to 48 MB blobs).
      expect(growth).toBeLessThan(blob.length / 3);
      expect(Buffer.compare(fs.readFileSync(path.join(folder, "big.bin")), blob)).toBe(0);
      expect(fs.readFileSync(path.join(folder, "after.txt"), "utf8")).toBe("After the large file");
    }, 120 * 1000);
  });

  describe("requests", function () {
    // Thirty commits adding a post and editing a document, in one pack
    function history() {
      const commits = [];
      for (let i = 1; i <= 30; i++) {
        const lines = Array.from({ length: 400 }, (_, n) => "line " + n + (n % 40 === i % 40 ? " edited " + i : "")).join("\n");
        commits.push(repo.commit({ "docs/big.txt": lines, ["posts/post-" + i + ".txt"]: "Post " + i, "data.bin": crypto.randomBytes(2000) }));
      }
      commits.push(repo.commit({ "posts/post-3.txt": "Post 3, edited" }));
      return commits;
    }

    const requests = (store) => store.stats.heads + store.stats.reads + store.stats.gets + store.stats.lists;

    it("takes a few requests for a one-file change, cold and warm", async function () {
      const commits = history();
      const from = commits[commits.length - 2];
      const to = commits[commits.length - 1];

      // Everything, for comparison
      const all = await repo.reader();
      await apply(all.reader, null, to);
      const everything = requests(all.store);

      // Cold: nothing in the cache
      const cache = createCache({ dir: path.join(tmp, "cache"), maxBytes: 64 * 1024 * 1024 });
      const { store, reader, entries } = await repo.reader({ cache });

      expect(await apply(reader, from, to)).toEqual({ written: 1, removed: 0, skipped: 0 });
      expect(fs.readFileSync(path.join(folder, "posts/post-3.txt"), "utf8")).toBe("Post 3, edited");

      const cold = requests(store);

      // The two commits, the root and posts/ on each side, and the blob, with
      // the index and pack checks. Far fewer than the whole tree takes.
      expect(cold).toBeLessThan(30);
      expect(cold).toBeLessThan(everything);

      // Warm: a new reader over the same cache. Without zlib.crc32 (Node 21
      // and earlier) the cache stores nothing, so it cannot help there.
      const warmReader = createReader({ store, cache, packs: entries });
      await apply(warmReader, from, to);
      const warm = requests(store) - cold;

      if (zlib.crc32) expect(warm).toBeLessThan(14);
      if (zlib.crc32) expect(warm).toBeLessThan(cold);
      expect(warm).toBeLessThanOrEqual(cold);
    });

    it("reads little for a range with the same tree on both sides", async function () {
      const first = repo.commit({ "a.txt": "A" });
      const second = repo.commit({}); // the same tree, a new commit
      const { reader, store } = await repo.reader();
      const before = requests(store);

      expect(await apply(reader, first, second)).toEqual({ written: 0, removed: 0, skipped: 0 });
      // The two commits, and no tree
      expect(requests(store) - before).toBeLessThan(12);
    });
  });
});
