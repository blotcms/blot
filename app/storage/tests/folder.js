describe("storage/folder", function () {
  var { Readable } = require("stream");
  global.test.blog();

  var folder = require("storage/folder");
  var hashFile = require("helper/hashFile");
  var fs = require("fs-extra");
  var os = require("os");
  var express = require("express");
  var fetch = require("node-fetch");
  var { join } = require("path");

  // A directory outside every blog folder, with a file a symlink might expose
  var outside;

  beforeEach(async function () {
    outside = await fs.mkdtemp(join(os.tmpdir(), "storage-folder-"));
    await fs.outputFile(join(outside, "secret.txt"), "secret");
  });

  afterEach(async function () {
    await fs.remove(outside);
  });

  async function rejection(promise) {
    try {
      await promise;
    } catch (err) {
      return err;
    }
  }

  async function slurp(stream) {
    var chunks = [];
    for await (var chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks).toString();
  }

  async function collect(iterator) {
    var found = [];
    for await (var item of iterator) found.push(item);
    return found;
  }

  function names(page) {
    return page.entries.map(function (entry) {
      return entry.name;
    });
  }

  describe("read", function () {
    it("reads a file, with or without a leading slash", async function () {
      await folder.write(this.blog.id, "/a.txt", "hello");

      expect((await folder.read(this.blog.id, "/a.txt")).toString()).toEqual("hello");
      expect((await folder.read(this.blog.id, "a.txt")).toString()).toEqual("hello");
    });

    it("rejects a missing file with NotFoundError and code ENOENT", async function () {
      var err = await rejection(folder.read(this.blog.id, "/nope.txt"));

      expect(err instanceof folder.NotFoundError).toBe(true);
      expect(err.code).toEqual("ENOENT");
    });

    it("treats a path below a file as missing", async function () {
      await folder.write(this.blog.id, "/a.txt", "x");

      var err = await rejection(folder.read(this.blog.id, "/a.txt/b"));

      expect(err.code).toEqual("ENOENT");
    });

    it("reads names with non-ASCII, spaces and control characters", async function () {
      var weird = [
        "/café ☕.txt",
        "/日本語/ファイル.txt",
        "/ leading and trailing .txt",
        "/tab\there.txt",
        "/new\nline.txt",
        "/quote\"'`.txt",
        "/100% #hash ?q.txt",
      ];

      for (var path of weird) {
        await folder.write(this.blog.id, path, path);
        expect((await folder.read(this.blog.id, path)).toString()).toEqual(path);
      }
    });
  });

  describe("path confinement", function () {
    it("keeps .. inside the blog's folder", async function () {
      await fs.outputFile(join(this.blogDirectory, "../escaped.txt"), "outside");

      var err = await rejection(folder.read(this.blog.id, "/../escaped.txt"));

      expect(err.code).toEqual("ENOENT");
      expect((await folder.path(this.blog.id, "/../../escaped.txt")).indexOf(this.blogDirectory + "/")).toEqual(0);
      expect(await folder.path(this.blog.id, "/a/../../../x")).toEqual(this.blogDirectory + "/x");

      await fs.remove(join(this.blogDirectory, "../escaped.txt"));
    });

    it("writes with .. inside the folder too", async function () {
      await folder.write(this.blog.id, "/../../escaped.txt", "x");

      expect(await fs.pathExists(join(this.blogDirectory, "escaped.txt"))).toBe(true);
      expect(await fs.pathExists(join(this.blogDirectory, "../escaped.txt"))).toBe(false);
    });

    it("rejects a blog ID which is a path", async function () {
      expect(await rejection(folder.path("../other", "/a.txt"))).toBeDefined();
      expect(await rejection(folder.path("", "/a.txt"))).toBeDefined();
    });

    it("rejects a null byte", async function () {
      expect(await rejection(folder.read(this.blog.id, "/a\0b"))).toBeDefined();
    });
  });

  describe("symlinks", function () {
    it("refuses to read through a symlink to a file", async function () {
      await fs.symlink(join(outside, "secret.txt"), join(this.blogDirectory, "link.txt"));

      var err = await rejection(folder.read(this.blog.id, "/link.txt"));

      expect(err.code).toEqual("ELOOP");
      expect((await rejection(folder.stat(this.blog.id, "/link.txt"))).code).toEqual("ELOOP");
      expect((await rejection(folder.ensureLocal(this.blog.id, "/link.txt"))).code).toEqual("ELOOP");
      expect((await collect2(folder.createReadStream(this.blog.id, "/link.txt"))).code).toEqual("ELOOP");
      expect(await folder.exists(this.blog.id, "/link.txt")).toBe(false);
    });

    it("refuses to read through a symlinked ancestor", async function () {
      await fs.symlink(outside, join(this.blogDirectory, "dir"));

      expect((await rejection(folder.read(this.blog.id, "/dir/secret.txt"))).code).toEqual("ELOOP");
      expect((await rejection(folder.list(this.blog.id, "/dir"))).code).toEqual("ELOOP");
      expect((await rejection(folder.resolveCaseInsensitive(this.blog.id, "/DIR/secret.txt"))).code).toEqual("ELOOP");
    });

    it("refuses to write through a symlink", async function () {
      await fs.symlink(join(outside, "secret.txt"), join(this.blogDirectory, "link.txt"));
      await fs.symlink(outside, join(this.blogDirectory, "dir"));

      expect((await rejection(folder.write(this.blog.id, "/link.txt", "x"))).code).toEqual("ELOOP");
      expect((await rejection(folder.write(this.blog.id, "/dir/new.txt", "x"))).code).toEqual("ELOOP");
      expect((await rejection(folder.mkdir(this.blog.id, "/dir/sub"))).code).toEqual("ELOOP");
      expect((await rejection(folder.commit(this.blog.id, "/dir/new.txt"))).code).toEqual("ELOOP");
      expect((await rejection(folder.remove(this.blog.id, "/dir/secret.txt"))).code).toEqual("ELOOP");

      expect(await fs.readFile(join(outside, "secret.txt"), "utf8")).toEqual("secret");
      expect(await fs.pathExists(join(outside, "new.txt"))).toBe(false);
    });

    it("never follows symlinks when listing or walking", async function () {
      await folder.write(this.blog.id, "/real.txt", "x");
      await fs.symlink(join(outside, "secret.txt"), join(this.blogDirectory, "link.txt"));
      await fs.symlink(outside, join(this.blogDirectory, "dir"));

      expect(names(await folder.list(this.blog.id, "/"))).toEqual(["real.txt"]);
      expect(await collect(folder.walk(this.blog.id, "/"))).toEqual(["/real.txt"]);
    });

    it("removes a symlink itself, not what it points at", async function () {
      await fs.symlink(outside, join(this.blogDirectory, "dir"));

      await folder.remove(this.blog.id, "/dir");

      expect(await fs.pathExists(join(this.blogDirectory, "dir"))).toBe(false);
      expect(await fs.pathExists(join(outside, "secret.txt"))).toBe(true);
    });

    // The error arrives as an event on the stream
    function collect2(stream) {
      return new Promise(function (resolve) {
        stream.on("error", resolve);
        stream.on("end", function () {
          resolve(new Error("no error"));
        });
        stream.resume();
      });
    }
  });

  describe("createReadStream", function () {
    it("streams a file and a byte range", async function () {
      await folder.write(this.blog.id, "/a.txt", "0123456789");

      expect(await slurp(folder.createReadStream(this.blog.id, "/a.txt"))).toEqual("0123456789");
      expect(await slurp(folder.createReadStream(this.blog.id, "/a.txt", { start: 2, end: 5 }))).toEqual("2345");
      expect(await slurp(folder.createReadStream(this.blog.id, "/a.txt", { start: 7 }))).toEqual("789");
    });

    it("emits NotFoundError for a missing file", async function () {
      var stream = folder.createReadStream(this.blog.id, "/nope.txt");
      var err = await new Promise(function (resolve) {
        stream.on("error", resolve);
        stream.resume();
      });

      expect(err instanceof folder.NotFoundError).toBe(true);
      expect(err.code).toEqual("ENOENT");
    });

    it("emits an invalid range as an error", async function () {
      await folder.write(this.blog.id, "/range.txt", "0123456789");

      var stream = folder.createReadStream(this.blog.id, "/range.txt", { start: 2, end: 1 });
      var err = await new Promise(function (resolve) {
        stream.on("error", resolve);
        stream.resume();
      });

      expect(err).toBeDefined();
    });
  });

  describe("write and writeFrom", function () {
    it("rejects when a stream fails before writing starts", async function () {
      var stream = fs.createReadStream(join(outside, "missing.txt"));

      expect((await rejection(folder.write(this.blog.id, "/early.txt", stream))).code).toEqual("ENOENT");
      expect(await folder.exists(this.blog.id, "/early.txt")).toBe(false);
    });

    it("writes a stream to a name near the filesystem's limit", async function () {
      var name = "/" + "a".repeat(250) + ".txt";

      await folder.write(this.blog.id, name, Readable.from([Buffer.from("long")]));

      expect((await folder.read(this.blog.id, name)).toString()).toEqual("long");
    });

    it("keeps the existing file when a stream fails part way", async function () {
      await folder.write(this.blog.id, "/keep.txt", "old");

      var stream = new Readable({
        read: function () {
          this.push("par");
          this.destroy(new Error("source failed"));
        },
      });

      expect(await rejection(folder.write(this.blog.id, "/keep.txt", stream))).toBeDefined();
      expect((await folder.read(this.blog.id, "/keep.txt")).toString()).toEqual("old");
      expect(await fs.readdir(this.blogDirectory)).toEqual(["keep.txt"]);
    });

    it("writes a buffer, a string and a stream, creating parents", async function () {
      var { Readable } = require("stream");

      await folder.write(this.blog.id, "/a/b/buffer.txt", Buffer.from("buffer"));
      await folder.write(this.blog.id, "/a/b/string.txt", "string");
      await folder.write(this.blog.id, "/a/b/stream.txt", Readable.from([Buffer.from("str"), Buffer.from("eam")]));

      expect(await fs.readFile(join(this.blogDirectory, "a/b/buffer.txt"), "utf8")).toEqual("buffer");
      expect(await fs.readFile(join(this.blogDirectory, "a/b/string.txt"), "utf8")).toEqual("string");
      expect(await fs.readFile(join(this.blogDirectory, "a/b/stream.txt"), "utf8")).toEqual("stream");
    });

    it("replaces an existing file", async function () {
      await folder.write(this.blog.id, "/a.txt", "one");
      await folder.write(this.blog.id, "/a.txt", "two");

      expect((await folder.read(this.blog.id, "/a.txt")).toString()).toEqual("two");
    });

    it("copies a local file in, leaving the source", async function () {
      var source = join(outside, "source.txt");
      await fs.outputFile(source, "copied");

      await folder.writeFrom(this.blog.id, "/x/copy.txt", source);

      expect((await folder.read(this.blog.id, "/x/copy.txt")).toString()).toEqual("copied");
      expect(await fs.pathExists(source)).toBe(true);
    });

    it("moves a local file in, replacing what is there", async function () {
      var source = join(outside, "source.txt");
      await fs.outputFile(source, "moved");
      await folder.write(this.blog.id, "/x/move.txt", "old");

      await folder.writeFrom(this.blog.id, "/x/move.txt", source, { move: true });

      expect((await folder.read(this.blog.id, "/x/move.txt")).toString()).toEqual("moved");
      expect(await fs.pathExists(source)).toBe(false);
    });

    it("refuses to write the folder itself", async function () {
      expect(await rejection(folder.write(this.blog.id, "/", "x"))).toBeDefined();
    });
  });

  describe("path and commit", function () {
    it("gives a tool the file's place and commits it", async function () {
      var place = await folder.path(this.blog.id, "/tool/out.txt");

      expect(place).toEqual(join(this.blogDirectory, "tool/out.txt"));

      await fs.outputFile(place, "from a tool");
      await folder.commit(this.blog.id, "/tool/out.txt");

      expect((await folder.read(this.blog.id, "/tool/out.txt")).toString()).toEqual("from a tool");
    });

    it("refuses a symlink before a tool can write through it", async function () {
      var target = join(outside, "target.txt");

      await fs.outputFile(target, "outside");
      await fs.ensureDir(this.blogDirectory);
      await fs.symlink(target, join(this.blogDirectory, "link.txt"));

      expect((await rejection(folder.path(this.blog.id, "/link.txt"))).code).toEqual("ELOOP");
    });
  });

  describe("removing below a file", function () {
    it("treats it as already missing", async function () {
      await folder.write(this.blog.id, "/former-directory", "now a file");

      await folder.remove(this.blog.id, "/former-directory/sub/file.txt");
      await folder.rmdir(this.blog.id, "/former-directory/sub");

      expect(await folder.exists(this.blog.id, "/former-directory")).toBe(true);
    });
  });

  describe("ensureLocal", function () {
    it("is the file itself", async function () {
      await folder.write(this.blog.id, "/a.txt", "x");

      expect(await folder.ensureLocal(this.blog.id, "/a.txt")).toEqual(join(this.blogDirectory, "a.txt"));
    });

    it("rejects a missing file with ENOENT", async function () {
      var err = await rejection(folder.ensureLocal(this.blog.id, "/nope.txt"));

      expect(err instanceof folder.NotFoundError).toBe(true);
    });
  });

  describe("mkdir, rmdir, remove and move", function () {
    it("makes nested directories", async function () {
      await folder.mkdir(this.blog.id, "/a/b/c");

      expect((await folder.stat(this.blog.id, "/a/b/c")).isDirectory).toBe(true);
    });

    it("rmdir removes a directory and everything in it", async function () {
      await folder.write(this.blog.id, "/d/x/1.txt", "1");
      await folder.write(this.blog.id, "/d/2.txt", "2");

      await folder.rmdir(this.blog.id, "/d");

      expect(await folder.exists(this.blog.id, "/d")).toBe(false);
    });

    it("rmdir of a missing directory is not an error, of a file it is", async function () {
      await folder.rmdir(this.blog.id, "/nope");
      await folder.write(this.blog.id, "/f.txt", "x");

      expect((await rejection(folder.rmdir(this.blog.id, "/f.txt"))).code).toEqual("ENOTDIR");
      expect(await folder.exists(this.blog.id, "/f.txt")).toBe(true);
    });

    it("remove deletes a file or a directory, and a missing path is fine", async function () {
      await folder.write(this.blog.id, "/f.txt", "x");
      await folder.write(this.blog.id, "/d/f.txt", "x");

      await folder.remove(this.blog.id, "/f.txt");
      await folder.remove(this.blog.id, "/d");
      await folder.remove(this.blog.id, "/nope");

      expect(await folder.exists(this.blog.id, "/f.txt")).toBe(false);
      expect(await folder.exists(this.blog.id, "/d")).toBe(false);
    });

    it("remove and rmdir will not empty the folder", async function () {
      await folder.write(this.blog.id, "/f.txt", "x");

      expect(await rejection(folder.remove(this.blog.id, "/"))).toBeDefined();
      expect(await rejection(folder.rmdir(this.blog.id, "/.."))).toBeDefined();
      expect(await folder.exists(this.blog.id, "/f.txt")).toBe(true);
    });

    it("moves a file, creating the destination's parents", async function () {
      await folder.write(this.blog.id, "/a.txt", "x");

      await folder.move(this.blog.id, "/a.txt", "/new/dir/b.txt");

      expect(await folder.exists(this.blog.id, "/a.txt")).toBe(false);
      expect((await folder.read(this.blog.id, "/new/dir/b.txt")).toString()).toEqual("x");
    });

    it("moves a directory over a directory, and a file over a file", async function () {
      await folder.write(this.blog.id, "/d/1.txt", "1");
      await folder.write(this.blog.id, "/target/old.txt", "old");
      await folder.write(this.blog.id, "/f.txt", "new");
      await folder.write(this.blog.id, "/g.txt", "old");

      await folder.move(this.blog.id, "/d", "/target");
      await folder.move(this.blog.id, "/f.txt", "/g.txt");

      expect((await folder.read(this.blog.id, "/target/1.txt")).toString()).toEqual("1");
      expect(await folder.exists(this.blog.id, "/target/old.txt")).toBe(false);
      expect((await folder.read(this.blog.id, "/g.txt")).toString()).toEqual("new");
    });

    it("rejects moving a missing path with ENOENT", async function () {
      var err = await rejection(folder.move(this.blog.id, "/nope", "/b"));

      expect(err.code).toEqual("ENOENT");
    });
  });

  describe("stat and exists", function () {
    it("describes a file", async function () {
      await folder.write(this.blog.id, "/a.txt", "12345");

      var stat = await folder.stat(this.blog.id, "/a.txt");
      var real = await fs.stat(join(this.blogDirectory, "a.txt"));

      expect(stat).toEqual({ isDirectory: false, size: 5, modified: real.mtimeMs });
      expect(stat.hash).toBeUndefined();
    });

    it("describes a directory without a hash", async function () {
      await folder.mkdir(this.blog.id, "/d");

      var stat = await folder.stat(this.blog.id, "/d", { hash: true });

      expect(stat.isDirectory).toBe(true);
      expect(stat.size).toEqual(0);
      expect(stat.hash).toBeUndefined();
    });

    it("includes the Dropbox content hash only when asked", async function () {
      // Larger than one 4 MB block, so the block hashing is exercised
      await folder.write(this.blog.id, "/big.bin", Buffer.alloc(5 * 1024 * 1024, "ab"));
      await folder.write(this.blog.id, "/empty.txt", "");

      var big = await folder.stat(this.blog.id, "/big.bin", { hash: true });
      var empty = await folder.stat(this.blog.id, "/empty.txt", { hash: true });

      expect(big.hash).toEqual(await hashFile(join(this.blogDirectory, "big.bin")));
      expect(empty.hash).toEqual(await hashFile(join(this.blogDirectory, "empty.txt")));
      expect(big.hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("rejects a missing file with ENOENT and exists is false", async function () {
      var err = await rejection(folder.stat(this.blog.id, "/nope.txt", { hash: true }));

      expect(err instanceof folder.NotFoundError).toBe(true);
      expect(err.code).toEqual("ENOENT");
      expect(await folder.exists(this.blog.id, "/nope.txt")).toBe(false);
    });

    it("exists is true for files and directories", async function () {
      await folder.write(this.blog.id, "/d/a.txt", "x");

      expect(await folder.exists(this.blog.id, "/d/a.txt")).toBe(true);
      expect(await folder.exists(this.blog.id, "/d")).toBe(true);
      expect(await folder.exists(this.blog.id, "/")).toBe(true);
    });
  });

  describe("list", function () {
    it("lists a directory sorted by name with stats", async function () {
      await folder.write(this.blog.id, "/b.txt", "bb");
      await folder.write(this.blog.id, "/a.txt", "a");
      await folder.mkdir(this.blog.id, "/c");

      var page = await folder.list(this.blog.id, "/");

      expect(page.cursor).toBeNull();
      expect(
        page.entries.map(function (entry) {
          return [entry.name, entry.isDirectory, entry.size];
        })
      ).toEqual([
        ["a.txt", false, 1],
        ["b.txt", false, 2],
        ["c", true, 0],
      ]);
      expect(typeof page.entries[0].modified).toEqual("number");
    });

    it("paginates across a cursor boundary without repeats or gaps", async function () {
      for (var i = 0; i < 7; i++) await folder.write(this.blog.id, "/d/f" + i + ".txt", "x");

      var first = await folder.list(this.blog.id, "/d", { limit: 3 });
      var second = await folder.list(this.blog.id, "/d", { limit: 3, cursor: first.cursor });
      var third = await folder.list(this.blog.id, "/d", { limit: 3, cursor: second.cursor });

      expect(names(first)).toEqual(["f0.txt", "f1.txt", "f2.txt"]);
      expect(typeof first.cursor).toEqual("string");
      expect(names(second)).toEqual(["f3.txt", "f4.txt", "f5.txt"]);
      expect(names(third)).toEqual(["f6.txt"]);
      expect(third.cursor).toBeNull();
    });

    it("ends with no cursor when the last page is exactly full", async function () {
      await folder.write(this.blog.id, "/d/a.txt", "x");
      await folder.write(this.blog.id, "/d/b.txt", "x");

      var page = await folder.list(this.blog.id, "/d", { limit: 2 });

      expect(names(page)).toEqual(["a.txt", "b.txt"]);
      expect(page.cursor).toBeNull();
    });

    it("keeps its place when entries change between pages", async function () {
      for (var name of ["a", "b", "c", "d"]) await folder.write(this.blog.id, "/d/" + name, "x");

      var first = await folder.list(this.blog.id, "/d", { limit: 2 });
      await folder.remove(this.blog.id, "/d/a");
      await folder.remove(this.blog.id, "/d/b");
      await folder.write(this.blog.id, "/d/bb", "x");
      var second = await folder.list(this.blog.id, "/d", { limit: 2, cursor: first.cursor });

      expect(names(second)).toEqual(["bb", "c"]);
    });

    it("sorts names with non-ASCII and control characters", async function () {
      for (var name of ["é", "z", "a b", "\tx", "日本"]) await folder.write(this.blog.id, "/d/" + name, "x");

      var page = await folder.list(this.blog.id, "/d");

      expect(names(page)).toEqual(["\tx", "a b", "z", "é", "日本"]);
    });

    it("rejects a missing directory with ENOENT, a bad cursor and a bad limit", async function () {
      expect((await rejection(folder.list(this.blog.id, "/nope"))).code).toEqual("ENOENT");
      expect((await rejection(folder.list(this.blog.id, "/nope"))) instanceof folder.NotFoundError).toBe(true);

      await folder.mkdir(this.blog.id, "/d");

      expect(await rejection(folder.list(this.blog.id, "/d", { cursor: "!!" }))).toBeDefined();
      expect(await rejection(folder.list(this.blog.id, "/d", { limit: 0 }))).toBeDefined();
    });

    it("lists an empty directory", async function () {
      await folder.mkdir(this.blog.id, "/d");

      expect(await folder.list(this.blog.id, "/d")).toEqual({ entries: [], cursor: null });
    });

    it("listNames gives sorted names and kinds, without symlinks", async function () {
      await folder.write(this.blog.id, "/d/b.txt", "bb");
      await folder.write(this.blog.id, "/d/a.txt", "a");
      await folder.mkdir(this.blog.id, "/d/c");
      await fs.symlink(join(outside, "secret.txt"), join(this.blogDirectory, "d", "link.txt"));

      expect(await folder.listNames(this.blog.id, "/d")).toEqual([
        { name: "a.txt", isDirectory: false },
        { name: "b.txt", isDirectory: false },
        { name: "c", isDirectory: true },
      ]);
    });

    it("listNames rejects a missing directory and a symlinked one", async function () {
      await fs.symlink(outside, join(this.blogDirectory, "dir"));

      var missing = await rejection(folder.listNames(this.blog.id, "/nope"));
      var linked = await rejection(folder.listNames(this.blog.id, "/dir"));

      expect(missing instanceof folder.NotFoundError).toBe(true);
      expect(linked.code).toEqual("ELOOP");
    });

    it("listAll collects every page", async function () {
      for (var i = 0; i < 5; i++) await folder.write(this.blog.id, "/d/" + i, "x");

      var all = await folder.listAll(this.blog.id, "/d");

      expect(
        all.map(function (entry) {
          return entry.name;
        })
      ).toEqual(["0", "1", "2", "3", "4"]);
    });
  });

  describe("walk", function () {
    it("yields files depth first, sorted, through nested and empty directories", async function () {
      await folder.write(this.blog.id, "/b.txt", "x");
      await folder.write(this.blog.id, "/a/deep/er/1.txt", "x");
      await folder.write(this.blog.id, "/a/0.txt", "x");
      await folder.write(this.blog.id, "/c d/é.txt", "x");
      await folder.mkdir(this.blog.id, "/empty");
      await folder.mkdir(this.blog.id, "/a/also/empty");

      expect(await collect(folder.walk(this.blog.id, "/"))).toEqual([
        "/a/0.txt",
        "/a/deep/er/1.txt",
        "/b.txt",
        "/c d/é.txt",
      ]);
    });

    it("yields directories before their contents when asked", async function () {
      await folder.write(this.blog.id, "/a/1.txt", "x");
      await folder.mkdir(this.blog.id, "/empty");

      expect(await collect(folder.walk(this.blog.id, "/", { directories: true }))).toEqual([
        "/a",
        "/a/1.txt",
        "/empty",
      ]);
    });

    it("walks a subdirectory, with paths relative to the blog folder", async function () {
      await folder.write(this.blog.id, "/a/b/1.txt", "x");
      await folder.write(this.blog.id, "/z.txt", "x");

      expect(await collect(folder.walk(this.blog.id, "/a"))).toEqual(["/a/b/1.txt"]);
    });

    it("yields nothing for an empty folder and rejects a missing directory", async function () {
      expect(await collect(folder.walk(this.blog.id, "/"))).toEqual([]);

      var err = await rejection(collect(folder.walk(this.blog.id, "/nope")));

      expect(err.code).toEqual("ENOENT");
    });

    it("can be stopped early", async function () {
      for (var i = 0; i < 5; i++) await folder.write(this.blog.id, "/d/" + i, "x");

      for await (var path of folder.walk(this.blog.id, "/")) {
        expect(path).toEqual("/d/0");
        break;
      }
    });
  });

  describe("resolveCaseInsensitive", function () {
    it("finds the stored spelling of every segment", async function () {
      await folder.write(this.blog.id, "/Templates/Style.CSS", "x");

      expect(await folder.resolveCaseInsensitive(this.blog.id, "/templates/style.css")).toEqual("/Templates/Style.CSS");
      expect(await folder.resolveCaseInsensitive(this.blog.id, "TEMPLATES/STYLE.CSS")).toEqual("/Templates/Style.CSS");
      expect(await folder.resolveCaseInsensitive(this.blog.id, "/")).toEqual("/");
    });

    it("prefers the exact name when case-only siblings exist", async function () {
      await folder.write(this.blog.id, "/Templates/a.txt", "upper");
      await folder.write(this.blog.id, "/templates/a.txt", "lower");

      expect(await folder.resolveCaseInsensitive(this.blog.id, "/Templates/a.txt")).toEqual("/Templates/a.txt");
      expect(await folder.resolveCaseInsensitive(this.blog.id, "/templates/a.txt")).toEqual("/templates/a.txt");
    });

    it("picks as helper/caseSensitivePath does when none is exact", async function () {
      await folder.write(this.blog.id, "/Templates/a.txt", "upper");
      await folder.write(this.blog.id, "/templates/a.txt", "lower");

      var caseSensitivePath = require("helper/caseSensitivePath");
      var listing = await fs.readdir(this.blogDirectory);
      var expected = caseSensitivePath.pick(listing, "TEMPLATES");

      expect(await folder.resolveCaseInsensitive(this.blog.id, "/TEMPLATES/a.txt")).toEqual("/" + expected + "/a.txt");
    });

    it("matches across Unicode normalisation", async function () {
      await folder.write(this.blog.id, "/Café.txt", "x");

      expect(await folder.resolveCaseInsensitive(this.blog.id, "/café.TXT")).toEqual("/Café.txt");
    });

    it("rejects a missing path with ENOENT, and a path below a file", async function () {
      await folder.write(this.blog.id, "/a.txt", "x");

      var missing = await rejection(folder.resolveCaseInsensitive(this.blog.id, "/b.txt"));
      var below = await rejection(folder.resolveCaseInsensitive(this.blog.id, "/A.TXT/b"));

      expect(missing instanceof folder.NotFoundError).toBe(true);
      expect(missing.code).toEqual("ENOENT");
      expect(below.code).toEqual("ENOENT");
    });

    it("keeps .. inside the folder", async function () {
      await folder.write(this.blog.id, "/a.txt", "x");

      expect(await folder.resolveCaseInsensitive(this.blog.id, "/../../A.TXT")).toEqual("/a.txt");
    });
  });

  describe("removeAll", function () {
    it("removes the blog's whole folder and nothing else", async function () {
      await folder.write(this.blog.id, "/a/b.txt", "x");

      await folder.removeAll(this.blog.id);

      expect(await fs.pathExists(this.blogDirectory)).toBe(false);
      expect(await fs.pathExists(join(this.blogDirectory, ".."))).toBe(true);
    });

    it("is fine when there is no folder", async function () {
      await folder.removeAll(this.blog.id);
      await folder.removeAll(this.blog.id);
    });

    it("removes a symlinked folder without following it", async function () {
      await fs.remove(this.blogDirectory);
      await fs.symlink(outside, this.blogDirectory);

      await folder.removeAll(this.blog.id);

      expect(await fs.pathExists(join(outside, "secret.txt"))).toBe(true);
    });
  });

  describe("serve", function () {
    var server, origin, blogID, options;

    beforeEach(function (done) {
      var test = this;
      blogID = test.blog.id;
      options = {};

      var app = express();

      app.use("/serve", function (req, res, next) {
        folder
          .serve(req, res, blogID, req.path, options)
          .catch(function (err) {
            if (err instanceof folder.NotFoundError) return res.sendStatus(404);
            if (err.code === "ELOOP") return res.sendStatus(403);
            next(err);
          });
      });

      server = app.listen(0, function () {
        origin = "http://127.0.0.1:" + server.address().port + "/serve";
        done();
      });
    });

    afterEach(function (done) {
      server.close(done);
    });

    it("serves a file with validators and caching headers", async function () {
      await folder.write(blogID, "/a.txt", "hello");
      options = { maxAge: "1y", immutable: true, headers: { "Content-Type": "text/x-test" } };

      var res = await fetch(origin + "/a.txt");

      expect(res.status).toEqual(200);
      expect(await res.text()).toEqual("hello");
      expect(res.headers.get("content-type")).toEqual("text/x-test");
      expect(res.headers.get("cache-control")).toEqual("public, max-age=31536000, immutable");
      expect(res.headers.get("accept-ranges")).toEqual("bytes");
      expect(res.headers.get("etag")).toBeTruthy();
      expect(res.headers.get("last-modified")).toBeTruthy();
    });

    it("answers a Range request with 206, and an unsatisfiable one with 416", async function () {
      await folder.write(blogID, "/a.txt", "0123456789");

      var partial = await fetch(origin + "/a.txt", { headers: { Range: "bytes=2-4" } });

      expect(partial.status).toEqual(206);
      expect(await partial.text()).toEqual("234");
      expect(partial.headers.get("content-range")).toEqual("bytes 2-4/10");

      var bad = await fetch(origin + "/a.txt", { headers: { Range: "bytes=50-60" } });

      expect(bad.status).toEqual(416);
    });

    it("answers a conditional request with 304", async function () {
      await folder.write(blogID, "/a.txt", "hello");

      var first = await fetch(origin + "/a.txt");
      var second = await fetch(origin + "/a.txt", {
        headers: { "If-None-Match": first.headers.get("etag") },
      });

      expect(second.status).toEqual(304);
    });

    it("serves dotfiles unless told to ignore them", async function () {
      await folder.write(blogID, "/.well-known/x.txt", "dot");

      expect((await fetch(origin + "/.well-known/x.txt")).status).toEqual(200);

      options = { dotfiles: "ignore" };

      expect((await fetch(origin + "/.well-known/x.txt")).status).toEqual(404);
    });

    it("serves a directory's index.html for a trailing slash", async function () {
      await folder.write(blogID, "/dir/index.html", "<p>index</p>");

      expect(await (await fetch(origin + "/dir/")).text()).toEqual("<p>index</p>");
      expect((await fetch(origin + "/dir")).status).toEqual(404);
    });

    it("rejects missing files with NotFoundError, so callers can fall through", async function () {
      expect((await fetch(origin + "/nope.txt")).status).toEqual(404);
    });

    it("will not serve a symlink, or a file below a symlinked directory", async function () {
      await fs.symlink(join(outside, "secret.txt"), join(this.blogDirectory, "link.txt"));
      await fs.symlink(outside, join(this.blogDirectory, "dir"));

      expect((await fetch(origin + "/link.txt")).status).toEqual(403);
      expect((await fetch(origin + "/dir/secret.txt")).status).toEqual(403);
    });

    it("keeps .. inside the folder", async function () {
      await fs.outputFile(join(this.blogDirectory, "../escaped.txt"), "outside");

      var err = await rejection(folder.serve({ headers: {} }, {}, blogID, "/../escaped.txt"));

      expect(err instanceof folder.NotFoundError).toBe(true);

      await fs.remove(join(this.blogDirectory, "../escaped.txt"));
    });
  });
});
