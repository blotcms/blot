// The contract of storage/folder, on S3 (MinIO here). Behaviour specific to
// the bucket (objects, markers, the index and the content cache) is specified
// after the shared contract.
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

  // A directory outside every blog folder, for files to copy in
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

  // The error arrives as an event on the stream
  function streamError(stream) {
    return new Promise(function (resolve) {
      stream.on("error", resolve);
      stream.on("end", function () {
        resolve(new Error("no error"));
      });
      stream.resume();
    });
  }

  // Serves the blog's folder with folder.serve on a local port. Sets origin
  // and lets each spec set options.
  function useServer(state) {
    var server;

    beforeEach(function (done) {
      var test = this;

      state.blogID = test.blog.id;
      state.options = {};

      var app = express();

      app.use("/serve", function (req, res, next) {
        folder
          .serve(req, res, state.blogID, req.path, state.options)
          .catch(function (err) {
            if (err instanceof folder.NotFoundError) return res.sendStatus(404);
            next(err);
          });
      });

      server = app.listen(0, function () {
        state.origin = "http://127.0.0.1:" + server.address().port + "/serve";
        done();
      });
    });

    afterEach(function (done) {
      server.close(done);
    });
  }

  // Everything a caller may rely on, whichever backend holds the folder
  function contract() {
    describe("read", function () {
      it("reads a file, with or without a leading slash", async function () {
        await folder.write(this.blog.id, "/a.txt", "hello");

        expect((await folder.read(this.blog.id, "/a.txt")).toString()).toEqual(
          "hello"
        );
        expect((await folder.read(this.blog.id, "a.txt")).toString()).toEqual(
          "hello"
        );
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
          expect((await folder.read(this.blog.id, path)).toString()).toEqual(
            path
          );
        }
      });
    });

    describe("path confinement", function () {
      it("writes with .. inside the folder", async function () {
        await folder.write(this.blog.id, "/../../escaped.txt", "x");

        expect(
          (await folder.read(this.blog.id, "/escaped.txt")).toString()
        ).toEqual("x");
        expect(await folder.listNames(this.blog.id, "/")).toEqual([
          { name: "escaped.txt", isDirectory: false },
        ]);
      });

      it("rejects a blog ID which is a path", async function () {
        expect(
          await rejection(folder.read("../other", "/a.txt"))
        ).toBeDefined();
        expect(await rejection(folder.read("", "/a.txt"))).toBeDefined();
        expect(
          await rejection(folder.write("a/b", "/a.txt", "x"))
        ).toBeDefined();
      });

      it("rejects a null byte", async function () {
        expect(
          await rejection(folder.read(this.blog.id, "/a\0b"))
        ).toBeDefined();
      });
    });

    describe("createReadStream", function () {
      it("streams a file and a byte range", async function () {
        await folder.write(this.blog.id, "/a.txt", "0123456789");

        expect(
          await slurp(folder.createReadStream(this.blog.id, "/a.txt"))
        ).toEqual("0123456789");
        expect(
          await slurp(
            folder.createReadStream(this.blog.id, "/a.txt", {
              start: 2,
              end: 5,
            })
          )
        ).toEqual("2345");
        expect(
          await slurp(
            folder.createReadStream(this.blog.id, "/a.txt", { start: 7 })
          )
        ).toEqual("789");
      });

      it("emits NotFoundError for a missing file", async function () {
        var err = await streamError(
          folder.createReadStream(this.blog.id, "/nope.txt")
        );

        expect(err instanceof folder.NotFoundError).toBe(true);
        expect(err.code).toEqual("ENOENT");
      });

      it("emits an invalid range as an error", async function () {
        await folder.write(this.blog.id, "/range.txt", "0123456789");

        var err = await streamError(
          folder.createReadStream(this.blog.id, "/range.txt", {
            start: 2,
            end: 1,
          })
        );

        expect(err.message).not.toEqual("no error");
      });
    });

    describe("write and writeFrom", function () {
      it("rejects when a stream fails before writing starts", async function () {
        var stream = fs.createReadStream(join(outside, "missing.txt"));

        expect(
          (await rejection(folder.write(this.blog.id, "/early.txt", stream)))
            .code
        ).toEqual("ENOENT");
        expect(await folder.exists(this.blog.id, "/early.txt")).toBe(false);
      });

      it("writes a stream to a name near the filesystem's limit", async function () {
        var name = "/" + "a".repeat(250) + ".txt";

        await folder.write(
          this.blog.id,
          name,
          Readable.from([Buffer.from("long")])
        );

        expect((await folder.read(this.blog.id, name)).toString()).toEqual(
          "long"
        );
      });

      it("keeps the existing file when a stream fails part way", async function () {
        await folder.write(this.blog.id, "/keep.txt", "old");

        var stream = new Readable({
          read: function () {
            this.push("par");
            this.destroy(new Error("source failed"));
          },
        });

        expect(
          await rejection(folder.write(this.blog.id, "/keep.txt", stream))
        ).toBeDefined();
        expect(
          (await folder.read(this.blog.id, "/keep.txt")).toString()
        ).toEqual("old");
        expect(await folder.listNames(this.blog.id, "/")).toEqual([
          { name: "keep.txt", isDirectory: false },
        ]);
      });

      it("writes a buffer, a string and a stream, creating parents", async function () {
        await folder.write(
          this.blog.id,
          "/a/b/buffer.txt",
          Buffer.from("buffer")
        );
        await folder.write(this.blog.id, "/a/b/string.txt", "string");
        await folder.write(
          this.blog.id,
          "/a/b/stream.txt",
          Readable.from([Buffer.from("str"), Buffer.from("eam")])
        );

        expect(
          (await folder.read(this.blog.id, "/a/b/buffer.txt")).toString()
        ).toEqual("buffer");
        expect(
          (await folder.read(this.blog.id, "/a/b/string.txt")).toString()
        ).toEqual("string");
        expect(
          (await folder.read(this.blog.id, "/a/b/stream.txt")).toString()
        ).toEqual("stream");
        expect((await folder.stat(this.blog.id, "/a/b")).isDirectory).toBe(
          true
        );
      });

      it("replaces an existing file", async function () {
        await folder.write(this.blog.id, "/a.txt", "one");
        await folder.write(this.blog.id, "/a.txt", "two");

        expect((await folder.read(this.blog.id, "/a.txt")).toString()).toEqual(
          "two"
        );
        expect((await folder.stat(this.blog.id, "/a.txt")).size).toEqual(3);
      });

      it("copies a local file in, leaving the source", async function () {
        var source = join(outside, "source.txt");
        await fs.outputFile(source, "copied");

        await folder.writeFrom(this.blog.id, "/x/copy.txt", source);

        expect(
          (await folder.read(this.blog.id, "/x/copy.txt")).toString()
        ).toEqual("copied");
        expect(await fs.pathExists(source)).toBe(true);
      });

      it("moves a local file in, replacing what is there", async function () {
        var source = join(outside, "source.txt");
        await fs.outputFile(source, "moved");
        await folder.write(this.blog.id, "/x/move.txt", "old");

        await folder.writeFrom(this.blog.id, "/x/move.txt", source, {
          move: true,
        });

        expect(
          (await folder.read(this.blog.id, "/x/move.txt")).toString()
        ).toEqual("moved");
        expect(await fs.pathExists(source)).toBe(false);
      });

      it("rejects copying in a missing local file with ENOENT", async function () {
        var err = await rejection(
          folder.writeFrom(this.blog.id, "/x.txt", join(outside, "missing.txt"))
        );

        expect(err.code).toEqual("ENOENT");
        expect(await folder.exists(this.blog.id, "/x.txt")).toBe(false);
      });

      it("refuses to write the folder itself", async function () {
        expect(
          await rejection(folder.write(this.blog.id, "/", "x"))
        ).toBeDefined();
      });

      it("refuses to write below a file", async function () {
        await folder.write(this.blog.id, "/f", "file");

        expect(
          await rejection(folder.write(this.blog.id, "/f/g.txt", "x"))
        ).toBeDefined();
        expect((await folder.read(this.blog.id, "/f")).toString()).toEqual(
          "file"
        );
      });
    });

    describe("path and commit", function () {
      it("gives a tool a place to write and commits what it wrote", async function () {
        var place = await folder.path(this.blog.id, "/tool/out.txt");

        await fs.outputFile(place, "from a tool");
        await folder.commit(this.blog.id, "/tool/out.txt");

        expect(
          (await folder.read(this.blog.id, "/tool/out.txt")).toString()
        ).toEqual("from a tool");
      });

      it("commits nothing when the tool wrote nothing", async function () {
        await folder.commit(this.blog.id, "/tool/none.txt");

        expect(await folder.exists(this.blog.id, "/tool/none.txt")).toBe(false);
      });
    });

    describe("removing below a file", function () {
      it("treats it as already missing", async function () {
        await folder.write(this.blog.id, "/former-directory", "now a file");

        await folder.remove(this.blog.id, "/former-directory/sub/file.txt");
        await folder.rmdir(this.blog.id, "/former-directory/sub");

        expect(await folder.exists(this.blog.id, "/former-directory")).toBe(
          true
        );
      });
    });

    describe("ensureLocal", function () {
      it("is a local file with the file's bytes", async function () {
        await folder.write(this.blog.id, "/a.txt", "x");

        var local = await folder.ensureLocal(this.blog.id, "/a.txt");

        expect(await fs.readFile(local, "utf8")).toEqual("x");
      });

      it("follows a change to the file", async function () {
        await folder.write(this.blog.id, "/a.txt", "one");
        await folder.ensureLocal(this.blog.id, "/a.txt");
        await folder.write(this.blog.id, "/a.txt", "two");

        expect(
          await fs.readFile(
            await folder.ensureLocal(this.blog.id, "/a.txt"),
            "utf8"
          )
        ).toEqual("two");
      });

      it("rejects a missing file with ENOENT", async function () {
        var err = await rejection(
          folder.ensureLocal(this.blog.id, "/nope.txt")
        );

        expect(err instanceof folder.NotFoundError).toBe(true);
      });
    });

    describe("withLocal", function () {
      it("calls fn with a local file holding the bytes, and resolves to its result", async function () {
        await folder.write(this.blog.id, "/a.txt", "held");

        var seen;
        var result = await folder.withLocal(
          this.blog.id,
          "/a.txt",
          async function (local) {
            seen = await fs.readFile(local, "utf8");
            return "result";
          }
        );

        expect(seen).toEqual("held");
        expect(result).toEqual("result");
      });

      it("follows a change to the file", async function () {
        await folder.write(this.blog.id, "/a.txt", "one");
        await folder.withLocal(this.blog.id, "/a.txt", async function () {});
        await folder.write(this.blog.id, "/a.txt", "two");

        expect(
          await folder.withLocal(this.blog.id, "/a.txt", function (local) {
            return fs.readFile(local, "utf8");
          })
        ).toEqual("two");
      });

      it("passes on fn's failure", async function () {
        await folder.write(this.blog.id, "/a.txt", "x");

        var err = await rejection(
          folder.withLocal(this.blog.id, "/a.txt", async function () {
            throw new Error("the tool failed");
          })
        );

        expect(err.message).toEqual("the tool failed");
      });

      it("rejects a missing file without calling fn", async function () {
        var fn = jasmine.createSpy("fn");
        var err = await rejection(
          folder.withLocal(this.blog.id, "/nope.txt", fn)
        );

        expect(err instanceof folder.NotFoundError).toBe(true);
        expect(fn).not.toHaveBeenCalled();
      });
    });

    describe("mkdir, rmdir, remove and move", function () {
      it("makes nested directories", async function () {
        await folder.mkdir(this.blog.id, "/a/b/c");

        expect((await folder.stat(this.blog.id, "/a/b/c")).isDirectory).toBe(
          true
        );
        expect((await folder.stat(this.blog.id, "/a/b")).isDirectory).toBe(
          true
        );
      });

      it("mkdir of an existing directory is fine", async function () {
        await folder.write(this.blog.id, "/a/f.txt", "x");
        await folder.mkdir(this.blog.id, "/a");
        await folder.mkdir(this.blog.id, "/a");

        expect(await folder.listNames(this.blog.id, "/a")).toEqual([
          { name: "f.txt", isDirectory: false },
        ]);
      });

      it("rmdir removes a directory and everything in it", async function () {
        await folder.write(this.blog.id, "/d/x/1.txt", "1");
        await folder.write(this.blog.id, "/d/2.txt", "2");

        await folder.rmdir(this.blog.id, "/d");

        expect(await folder.exists(this.blog.id, "/d")).toBe(false);
        expect(await folder.exists(this.blog.id, "/d/x/1.txt")).toBe(false);
      });

      it("rmdir of a missing directory is not an error, of a file it is", async function () {
        await folder.rmdir(this.blog.id, "/nope");
        await folder.write(this.blog.id, "/f.txt", "x");

        expect(
          (await rejection(folder.rmdir(this.blog.id, "/f.txt"))).code
        ).toEqual("ENOTDIR");
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

      it("keeps a directory when its last file is removed", async function () {
        await folder.write(this.blog.id, "/d/f.txt", "x");

        await folder.remove(this.blog.id, "/d/f.txt");

        expect((await folder.stat(this.blog.id, "/d")).isDirectory).toBe(true);
        expect(await folder.listNames(this.blog.id, "/d")).toEqual([]);
      });

      it("remove and rmdir will not empty the folder", async function () {
        await folder.write(this.blog.id, "/f.txt", "x");

        expect(await rejection(folder.remove(this.blog.id, "/"))).toBeDefined();
        expect(
          await rejection(folder.rmdir(this.blog.id, "/.."))
        ).toBeDefined();
        expect(await folder.exists(this.blog.id, "/f.txt")).toBe(true);
      });

      it("moves a file, creating the destination's parents", async function () {
        await folder.write(this.blog.id, "/a.txt", "x");

        await folder.move(this.blog.id, "/a.txt", "/new/dir/b.txt");

        expect(await folder.exists(this.blog.id, "/a.txt")).toBe(false);
        expect(
          (await folder.read(this.blog.id, "/new/dir/b.txt")).toString()
        ).toEqual("x");
      });

      it("moves a directory over a directory, and a file over a file", async function () {
        await folder.write(this.blog.id, "/d/1.txt", "1");
        await folder.write(this.blog.id, "/target/old.txt", "old");
        await folder.write(this.blog.id, "/f.txt", "new");
        await folder.write(this.blog.id, "/g.txt", "old");

        await folder.move(this.blog.id, "/d", "/target");
        await folder.move(this.blog.id, "/f.txt", "/g.txt");

        expect(
          (await folder.read(this.blog.id, "/target/1.txt")).toString()
        ).toEqual("1");
        expect(await folder.exists(this.blog.id, "/target/old.txt")).toBe(
          false
        );
        expect(await folder.exists(this.blog.id, "/d")).toBe(false);
        expect((await folder.read(this.blog.id, "/g.txt")).toString()).toEqual(
          "new"
        );
      });

      it("moves a directory with nested and empty directories in it", async function () {
        await folder.write(this.blog.id, "/d/a/1.txt", "1");
        await folder.mkdir(this.blog.id, "/d/empty");

        await folder.move(this.blog.id, "/d", "/e");

        expect(
          await collect(folder.walk(this.blog.id, "/", { directories: true }))
        ).toEqual(["/e", "/e/a", "/e/a/1.txt", "/e/empty"]);
      });

      it("renames a file to a different case", async function () {
        await folder.write(this.blog.id, "/Photo.JPG", "x");

        await folder.move(this.blog.id, "/Photo.JPG", "/photo.jpg");

        expect(await folder.listNames(this.blog.id, "/")).toEqual([
          { name: "photo.jpg", isDirectory: false },
        ]);
      });

      it("refuses to move onto its own ancestor, losing nothing", async function () {
        await folder.write(this.blog.id, "/a/b/c.txt", "c");
        await folder.write(this.blog.id, "/a/d.txt", "d");

        expect(
          (await rejection(folder.move(this.blog.id, "/a/b", "/a"))).code
        ).toEqual("EINVAL");
        expect(
          (await rejection(folder.move(this.blog.id, "/a/b/c.txt", "/a"))).code
        ).toEqual("EINVAL");

        expect(
          (await folder.read(this.blog.id, "/a/b/c.txt")).toString()
        ).toEqual("c");
        expect(
          (await folder.read(this.blog.id, "/a/d.txt")).toString()
        ).toEqual("d");
      });

      it("rejects moving a missing path with ENOENT", async function () {
        var err = await rejection(folder.move(this.blog.id, "/nope", "/b"));

        expect(err.code).toEqual("ENOENT");
      });
    });

    describe("stat and exists", function () {
      it("describes a file", async function () {
        var before = Date.now();

        await folder.write(this.blog.id, "/a.txt", "12345");

        var stat = await folder.stat(this.blog.id, "/a.txt");

        expect(Object.keys(stat).sort()).toEqual([
          "isDirectory",
          "modified",
          "size",
        ]);
        expect(stat.isDirectory).toBe(false);
        expect(stat.size).toEqual(5);
        // Filesystems may round the time down a little
        expect(stat.modified).toBeGreaterThanOrEqual(before - 2000);
        expect(stat.modified).toBeLessThanOrEqual(Date.now() + 1000);
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
        var bytes = Buffer.alloc(5 * 1024 * 1024, "ab");

        await folder.write(this.blog.id, "/big.bin", bytes);
        await folder.write(this.blog.id, "/empty.txt", "");
        await fs.outputFile(join(outside, "big.bin"), bytes);
        await fs.outputFile(join(outside, "empty.txt"), "");

        var big = await folder.stat(this.blog.id, "/big.bin", { hash: true });
        var empty = await folder.stat(this.blog.id, "/empty.txt", {
          hash: true,
        });

        expect(big.hash).toEqual(await hashFile(join(outside, "big.bin")));
        expect(empty.hash).toEqual(await hashFile(join(outside, "empty.txt")));
        expect(big.hash).toMatch(/^[0-9a-f]{64}$/);
      });

      it("includes the SHA-1 of the file's bytes only when asked", async function () {
        var crypto = require("crypto");

        await folder.write(this.blog.id, "/a.txt", "hello");
        await folder.write(this.blog.id, "/empty.txt", "");
        await folder.mkdir(this.blog.id, "/d");

        // Whichever backend holds the file, the same bytes give the same hash
        expect(
          (await folder.stat(this.blog.id, "/a.txt", { sha1: true })).sha1
        ).toEqual(crypto.createHash("sha1").update("hello").digest("hex"));
        expect(
          (await folder.stat(this.blog.id, "/empty.txt", { sha1: true })).sha1
        ).toEqual(crypto.createHash("sha1").update("").digest("hex"));
        expect(
          (await folder.stat(this.blog.id, "/a.txt")).sha1
        ).toBeUndefined();
        expect(
          (await folder.stat(this.blog.id, "/d", { sha1: true })).sha1
        ).toBeUndefined();
      });

      it("rejects a missing file with ENOENT and exists is false", async function () {
        var err = await rejection(
          folder.stat(this.blog.id, "/nope.txt", { hash: true })
        );

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

    describe("placeholders and flags", function () {
      var TOO_LARGE = { code: "SYNC_TOO_LARGE", size: 200, limit: 100 };

      it("writes an empty placeholder which stat reports as one", async function () {
        await folder.writePlaceholder(this.blog.id, "/big.mov", TOO_LARGE);

        var stat = await folder.stat(this.blog.id, "/big.mov");

        expect(stat.size).toEqual(0);
        expect(stat.placeholder).toBe(true);
        expect(stat.flags).toEqual([TOO_LARGE]);
        expect(
          (await folder.read(this.blog.id, "/big.mov")).toString()
        ).toEqual("");
      });

      it("tells a placeholder from a file which really is empty", async function () {
        await folder.write(this.blog.id, "/empty.txt", "");

        var stat = await folder.stat(this.blog.id, "/empty.txt");

        expect(stat.placeholder).toBeUndefined();
        expect(stat.flags).toBeUndefined();
      });

      it("refuses a code which isn't a placeholder's, or isn't known", async function () {
        var notPlaceholder = await rejection(
          folder.writePlaceholder(this.blog.id, "/a.txt", {
            code: "SYNC_FAILED",
          })
        );
        var unknown = await rejection(
          folder.writePlaceholder(this.blog.id, "/a.txt", { code: "NOPE" })
        );

        expect(notPlaceholder instanceof Error).toBe(true);
        expect(unknown instanceof Error).toBe(true);
        expect(await folder.exists(this.blog.id, "/a.txt")).toBe(false);
      });

      it("drops a file's flags when its bytes are replaced", async function () {
        await folder.writePlaceholder(this.blog.id, "/big.mov", TOO_LARGE);
        await folder.write(this.blog.id, "/big.mov", "real bytes");

        var stat = await folder.stat(this.blog.id, "/big.mov");

        expect(stat.placeholder).toBeUndefined();
        expect(stat.flags).toBeUndefined();
      });

      it("keeps a file's flags when it moves", async function () {
        await folder.writePlaceholder(this.blog.id, "/big.mov", TOO_LARGE);
        await folder.move(this.blog.id, "/big.mov", "/videos/big.mov");

        expect(
          (await folder.stat(this.blog.id, "/videos/big.mov")).placeholder
        ).toBe(true);
      });

      it("replaces only one source's flags", async function () {
        await folder.write(this.blog.id, "/a.md", "# Hi");
        await folder.setFlags(this.blog.id, "/a.md", "build", [
          { code: "BUILD_FAILED", error: "bad" },
        ]);
        await folder.setFlags(this.blog.id, "/a.md", "references", [
          { code: "BROKEN_IMAGE", targets: ["/x.png"] },
        ]);
        await folder.setFlags(this.blog.id, "/a.md", "build", []);

        expect((await folder.stat(this.blog.id, "/a.md")).flags).toEqual([
          { code: "BROKEN_IMAGE", targets: ["/x.png"] },
        ]);
      });

      it("doesn't flag bytes it never saw", async function () {
        await folder.write(this.blog.id, "/a.md", "# Hi");

        var flagged = await folder.setFlags(
          this.blog.id,
          "/a.md",
          "build",
          [{ code: "BUILD_FAILED" }],
          { sha1: "0".repeat(40) }
        );

        expect(flagged).toBe(false);
        expect(
          await folder.setFlags(this.blog.id, "/none.md", "build", [])
        ).toBe(false);
        expect(
          (await folder.stat(this.blog.id, "/a.md")).flags
        ).toBeUndefined();
      });

      it("caps a flag's detail", async function () {
        var targets = [];
        for (var i = 0; i < 30; i++) targets.push("/missing-" + i + ".png");

        await folder.write(this.blog.id, "/a.md", "# Hi");
        await folder.setFlags(this.blog.id, "/a.md", "references", [
          { code: "BROKEN_IMAGE", targets: targets, ignored: "not detail" },
        ]);
        await folder.setFlags(this.blog.id, "/a.md", "build", [
          { code: "BUILD_FAILED", error: "x".repeat(500) },
        ]);

        var flags = (await folder.stat(this.blog.id, "/a.md")).flags;

        expect(flags[0]).toEqual({
          code: "BROKEN_IMAGE",
          targets: targets.slice(0, 20),
          count: 30,
        });
        expect(flags[1].error.length).toEqual(200);
      });

      it("gives a flagged file's flags in a listing", async function () {
        await folder.writePlaceholder(this.blog.id, "/big.mov", TOO_LARGE);
        await folder.write(this.blog.id, "/a.txt", "a");

        var entries = (await folder.list(this.blog.id, "/")).entries;

        expect(entries[0].name).toEqual("a.txt");
        expect(entries[0].flags).toBeUndefined();
        expect(entries[1].flags).toEqual([TOO_LARGE]);
        expect(entries[1].placeholder).toBe(true);
      });

      it("lists the folder's flagged files", async function () {
        await folder.writePlaceholder(this.blog.id, "/a/big.mov", TOO_LARGE);
        await folder.write(this.blog.id, "/b.md", "# Hi");
        await folder.write(this.blog.id, "/c.txt", "");
        await folder.setFlags(this.blog.id, "/b.md", "build", [
          { code: "BUILD_FAILED" },
        ]);

        var found = [];
        for await (var file of folder.flagged(this.blog.id)) found.push(file);

        found.sort(function (a, b) {
          return a.path < b.path ? -1 : 1;
        });

        expect(
          found.map(function (file) {
            return [file.path, file.placeholder];
          })
        ).toEqual([
          ["/a/big.mov", true],
          ["/b.md", false],
        ]);
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
        for (var i = 0; i < 7; i++)
          await folder.write(this.blog.id, "/d/f" + i + ".txt", "x");

        var first = await folder.list(this.blog.id, "/d", { limit: 3 });
        var second = await folder.list(this.blog.id, "/d", {
          limit: 3,
          cursor: first.cursor,
        });
        var third = await folder.list(this.blog.id, "/d", {
          limit: 3,
          cursor: second.cursor,
        });

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
        for (var name of ["a", "b", "c", "d"])
          await folder.write(this.blog.id, "/d/" + name, "x");

        var first = await folder.list(this.blog.id, "/d", { limit: 2 });
        await folder.remove(this.blog.id, "/d/a");
        await folder.remove(this.blog.id, "/d/b");
        await folder.write(this.blog.id, "/d/bb", "x");
        var second = await folder.list(this.blog.id, "/d", {
          limit: 2,
          cursor: first.cursor,
        });

        expect(names(second)).toEqual(["bb", "c"]);
      });

      it("sorts names with non-ASCII and control characters", async function () {
        for (var name of ["é", "z", "a b", "\tx", "日本"])
          await folder.write(this.blog.id, "/d/" + name, "x");

        var page = await folder.list(this.blog.id, "/d");

        expect(names(page)).toEqual(["\tx", "a b", "z", "é", "日本"]);
      });

      it("rejects a missing directory with ENOENT, a bad cursor and a bad limit", async function () {
        expect(
          (await rejection(folder.list(this.blog.id, "/nope"))).code
        ).toEqual("ENOENT");
        expect(
          (await rejection(folder.list(this.blog.id, "/nope"))) instanceof
            folder.NotFoundError
        ).toBe(true);

        await folder.mkdir(this.blog.id, "/d");

        expect(
          await rejection(folder.list(this.blog.id, "/d", { cursor: "!!" }))
        ).toBeDefined();
        expect(
          await rejection(folder.list(this.blog.id, "/d", { limit: 0 }))
        ).toBeDefined();
      });

      it("lists an empty directory", async function () {
        await folder.mkdir(this.blog.id, "/d");

        expect(await folder.list(this.blog.id, "/d")).toEqual({
          entries: [],
          cursor: null,
        });
      });

      it("listNames gives sorted names and kinds", async function () {
        await folder.write(this.blog.id, "/d/b.txt", "bb");
        await folder.write(this.blog.id, "/d/a.txt", "a");
        await folder.mkdir(this.blog.id, "/d/c");

        expect(await folder.listNames(this.blog.id, "/d")).toEqual([
          { name: "a.txt", isDirectory: false },
          { name: "b.txt", isDirectory: false },
          { name: "c", isDirectory: true },
        ]);
      });

      it("listNames rejects a missing directory", async function () {
        var missing = await rejection(folder.listNames(this.blog.id, "/nope"));

        expect(missing instanceof folder.NotFoundError).toBe(true);
      });

      it("listAll collects every page", async function () {
        for (var i = 0; i < 5; i++)
          await folder.write(this.blog.id, "/d/" + i, "x");

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

      it("visits a directory before a sibling which sorts after it only by a longer name", async function () {
        await folder.write(this.blog.id, "/a b.txt", "x");
        await folder.write(this.blog.id, "/a/1.txt", "x");

        expect(await collect(folder.walk(this.blog.id, "/"))).toEqual([
          "/a/1.txt",
          "/a b.txt",
        ]);
      });

      it("yields directories before their contents when asked", async function () {
        await folder.write(this.blog.id, "/a/1.txt", "x");
        await folder.mkdir(this.blog.id, "/empty");

        expect(
          await collect(folder.walk(this.blog.id, "/", { directories: true }))
        ).toEqual(["/a", "/a/1.txt", "/empty"]);
      });

      it("walks a subdirectory, with paths relative to the blog folder", async function () {
        await folder.write(this.blog.id, "/a/b/1.txt", "x");
        await folder.write(this.blog.id, "/z.txt", "x");

        expect(await collect(folder.walk(this.blog.id, "/a"))).toEqual([
          "/a/b/1.txt",
        ]);
      });

      it("yields nothing for an empty folder and rejects a missing directory", async function () {
        expect(await collect(folder.walk(this.blog.id, "/"))).toEqual([]);

        var err = await rejection(collect(folder.walk(this.blog.id, "/nope")));

        expect(err.code).toEqual("ENOENT");
      });

      it("can be stopped early", async function () {
        for (var i = 0; i < 5; i++)
          await folder.write(this.blog.id, "/d/" + i, "x");

        for await (var path of folder.walk(this.blog.id, "/")) {
          expect(path).toEqual("/d/0");
          break;
        }
      });
    });

    describe("resolveCaseInsensitive", function () {
      it("finds the stored spelling of every segment", async function () {
        await folder.write(this.blog.id, "/Templates/Style.CSS", "x");

        expect(
          await folder.resolveCaseInsensitive(
            this.blog.id,
            "/templates/style.css"
          )
        ).toEqual("/Templates/Style.CSS");
        expect(
          await folder.resolveCaseInsensitive(
            this.blog.id,
            "TEMPLATES/STYLE.CSS"
          )
        ).toEqual("/Templates/Style.CSS");
        expect(await folder.resolveCaseInsensitive(this.blog.id, "/")).toEqual(
          "/"
        );
      });

      it("prefers the exact name when case-only siblings exist", async function () {
        await folder.write(this.blog.id, "/Templates/a.txt", "upper");
        await folder.write(this.blog.id, "/templates/a.txt", "lower");

        expect(
          await folder.resolveCaseInsensitive(this.blog.id, "/Templates/a.txt")
        ).toEqual("/Templates/a.txt");
        expect(
          await folder.resolveCaseInsensitive(this.blog.id, "/templates/a.txt")
        ).toEqual("/templates/a.txt");
      });

      it("picks one of the case-only siblings when none is exact", async function () {
        await folder.write(this.blog.id, "/Templates/a.txt", "upper");
        await folder.write(this.blog.id, "/templates/a.txt", "lower");

        expect(["/Templates/a.txt", "/templates/a.txt"]).toContain(
          await folder.resolveCaseInsensitive(this.blog.id, "/TEMPLATES/a.txt")
        );
      });

      it("finds the sibling left when one of two case-only siblings goes", async function () {
        await folder.write(this.blog.id, "/Templates/a.txt", "upper");
        await folder.write(this.blog.id, "/templates/a.txt", "lower");
        await folder.remove(this.blog.id, "/Templates");

        expect(
          await folder.resolveCaseInsensitive(this.blog.id, "/TEMPLATES/A.TXT")
        ).toEqual("/templates/a.txt");
      });

      it("matches across Unicode normalisation", async function () {
        await folder.write(this.blog.id, "/Café.txt", "x");

        expect(
          await folder.resolveCaseInsensitive(this.blog.id, "/café.TXT")
        ).toEqual("/Café.txt");
      });

      it("rejects a missing path with ENOENT, and a path below a file", async function () {
        await folder.write(this.blog.id, "/a.txt", "x");

        var missing = await rejection(
          folder.resolveCaseInsensitive(this.blog.id, "/b.txt")
        );
        var below = await rejection(
          folder.resolveCaseInsensitive(this.blog.id, "/A.TXT/b")
        );

        expect(missing instanceof folder.NotFoundError).toBe(true);
        expect(missing.code).toEqual("ENOENT");
        expect(below.code).toEqual("ENOENT");
      });

      it("keeps .. inside the folder", async function () {
        await folder.write(this.blog.id, "/a.txt", "x");

        expect(
          await folder.resolveCaseInsensitive(this.blog.id, "/../../A.TXT")
        ).toEqual("/a.txt");
      });
    });

    describe("removeAll", function () {
      it("removes the blog's whole folder", async function () {
        await folder.write(this.blog.id, "/a/b.txt", "x");

        await folder.removeAll(this.blog.id);

        expect(await folder.exists(this.blog.id, "/a/b.txt")).toBe(false);
        expect(await folder.exists(this.blog.id, "/a")).toBe(false);
      });

      it("is fine when there is no folder", async function () {
        await folder.removeAll(this.blog.id);
        await folder.removeAll(this.blog.id);
      });
    });

    describe("serve", function () {
      var state = {};

      useServer(state);

      it("serves a file with validators and caching headers", async function () {
        await folder.write(state.blogID, "/a.txt", "hello");
        state.options = {
          maxAge: "1y",
          immutable: true,
          headers: { "Content-Type": "text/x-test" },
        };

        var res = await fetch(state.origin + "/a.txt");

        expect(res.status).toEqual(200);
        expect(await res.text()).toEqual("hello");
        expect(res.headers.get("content-type")).toEqual("text/x-test");
        expect(res.headers.get("cache-control")).toEqual(
          "public, max-age=31536000, immutable"
        );
        expect(res.headers.get("accept-ranges")).toEqual("bytes");
        expect(res.headers.get("etag")).toBeTruthy();
        expect(res.headers.get("last-modified")).toBeTruthy();
      });

      it("answers a Range request with 206, and an unsatisfiable one with 416", async function () {
        await folder.write(state.blogID, "/a.txt", "0123456789");

        var partial = await fetch(state.origin + "/a.txt", {
          headers: { Range: "bytes=2-4" },
        });

        expect(partial.status).toEqual(206);
        expect(await partial.text()).toEqual("234");
        expect(partial.headers.get("content-range")).toEqual("bytes 2-4/10");

        var bad = await fetch(state.origin + "/a.txt", {
          headers: { Range: "bytes=50-60" },
        });

        expect(bad.status).toEqual(416);
      });

      it("answers a conditional request with 304", async function () {
        await folder.write(state.blogID, "/a.txt", "hello");

        var first = await fetch(state.origin + "/a.txt");
        var second = await fetch(state.origin + "/a.txt", {
          headers: { "If-None-Match": first.headers.get("etag") },
        });

        expect(second.status).toEqual(304);
      });

      it("serves dotfiles unless told to ignore them", async function () {
        await folder.write(state.blogID, "/.well-known/x.txt", "dot");

        expect(
          (await fetch(state.origin + "/.well-known/x.txt")).status
        ).toEqual(200);

        state.options = { dotfiles: "ignore" };

        expect(
          (await fetch(state.origin + "/.well-known/x.txt")).status
        ).toEqual(404);
      });

      it("serves a directory's index.html for a trailing slash", async function () {
        await folder.write(state.blogID, "/dir/index.html", "<p>index</p>");

        expect(await (await fetch(state.origin + "/dir/")).text()).toEqual(
          "<p>index</p>"
        );
        expect((await fetch(state.origin + "/dir")).status).toEqual(404);
      });

      it("rejects missing files with NotFoundError, so callers can fall through", async function () {
        expect((await fetch(state.origin + "/nope.txt")).status).toEqual(404);
      });

      it("keeps .. inside the folder", async function () {
        var err = await rejection(
          folder.serve({ headers: {} }, {}, state.blogID, "/../escaped.txt")
        );

        expect(err instanceof folder.NotFoundError).toBe(true);
      });
    });
  }

  describe("on S3", function () {
    var config = require("config");
    var crypto = require("crypto");
    var s3 = require("storage/s3");
    var File = require("models/file");
    var backend = require("storage/folder/s3");

    require("./minio")();

    contract();

    function sha1(text) {
      return crypto.createHash("sha1").update(text).digest("hex");
    }

    async function keys(blogID) {
      var found = [];
      for await (var entry of s3.listEntries(backend.root(blogID)))
        found.push(entry.key);
      return found.sort();
    }

    describe("objects and the index", function () {
      it("keeps a file at {blogID}/folder/{path} and records it", async function () {
        await folder.write(this.blog.id, "/a/b.txt", "hello");

        expect(await keys(this.blog.id)).toEqual([
          this.blog.id + "/folder/a/b.txt",
        ]);

        var record = await File.get(this.blog.id, "/a/b.txt");

        expect(record.type).toEqual("file");
        expect(record.size).toEqual(5);
        expect(record.sha1).toEqual(sha1("hello"));
        expect(await File.totals(this.blog.id)).toEqual({ bytes: 5, files: 1 });
      });

      it("leaves the blog's other keys alone, even on removeAll", async function () {
        var assetKey = this.blog.id + "/_assets/x.css";
        var gitKey = this.blog.id + "/git/x";

        await s3.putBuffer(assetKey, "x");
        await s3.putBuffer(gitKey, "x");
        await folder.write(this.blog.id, "/a/b.txt", "hello");
        await folder.mkdir(this.blog.id, "/c");

        expect(await keys(this.blog.id)).toEqual([
          this.blog.id + "/folder/a/b.txt",
          this.blog.id + "/folder/c/",
        ]);

        await folder.removeAll(this.blog.id);

        expect(await s3.head(assetKey)).not.toBeNull();
        expect(await s3.head(gitKey)).not.toBeNull();
        expect(await keys(this.blog.id)).toEqual([]);
      });

      it("hashes a stream and a copied file as they upload", async function () {
        var source = join(outside, "source.txt");
        await fs.outputFile(source, "from disk");

        await folder.write(
          this.blog.id,
          "/s.txt",
          Readable.from([Buffer.from("str"), Buffer.from("eam")])
        );
        await folder.writeFrom(this.blog.id, "/c.txt", source);

        expect((await File.get(this.blog.id, "/s.txt")).sha1).toEqual(
          sha1("stream")
        );
        expect((await File.get(this.blog.id, "/c.txt")).sha1).toEqual(
          sha1("from disk")
        );
      });

      it("makes a marker object for an explicit directory, and removes it with the directory", async function () {
        await folder.mkdir(this.blog.id, "/d/e");

        expect(await keys(this.blog.id)).toEqual([
          this.blog.id + "/folder/d/e/",
        ]);

        await folder.write(this.blog.id, "/d/e/f.txt", "x");
        await folder.rmdir(this.blog.id, "/d");

        expect(await keys(this.blog.id)).toEqual([]);
        expect(await File.get(this.blog.id, "/d/e")).toBeNull();
        expect(await File.totals(this.blog.id)).toEqual({ bytes: 0, files: 0 });
      });

      it("leaves a marker when a remove empties a directory", async function () {
        await folder.write(this.blog.id, "/d/f.txt", "x");

        expect(await keys(this.blog.id)).toEqual([
          this.blog.id + "/folder/d/f.txt",
        ]);

        await folder.remove(this.blog.id, "/d/f.txt");

        expect(await keys(this.blog.id)).toEqual([this.blog.id + "/folder/d/"]);
      });

      it("keeps the source's modified time when a local file is moved in", async function () {
        var source = join(outside, "old.txt");
        var then = new Date("2020-01-02T03:04:05Z");

        await fs.outputFile(source, "old");
        await fs.utimes(source, then, then);

        await folder.writeFrom(this.blog.id, "/old.txt", source, {
          move: true,
        });

        expect((await folder.stat(this.blog.id, "/old.txt")).modified).toEqual(
          then.getTime()
        );
      });

      it("keeps sizes, times and hashes when a directory moves", async function () {
        await folder.write(this.blog.id, "/d/a/1.txt", "one");

        var before = await File.get(this.blog.id, "/d/a/1.txt");

        await folder.move(this.blog.id, "/d", "/e");

        expect(await File.get(this.blog.id, "/e/a/1.txt")).toEqual(before);
        expect(await keys(this.blog.id)).toEqual([
          this.blog.id + "/folder/e/a/1.txt",
        ]);
        expect(await File.totals(this.blog.id)).toEqual({ bytes: 3, files: 1 });
      });

      it("gives a moved file the Content-Type of its new name", async function () {
        await folder.write(this.blog.id, "/theme.txt", "body {}");
        await folder.write(this.blog.id, "/d/style.txt", "p {}");
        await folder.mkdir(this.blog.id, "/d/empty");

        await folder.move(this.blog.id, "/theme.txt", "/theme.css");
        await folder.move(this.blog.id, "/d", "/e");

        expect(
          (await s3.head(this.blog.id + "/folder/theme.css")).contentType
        ).toMatch(/^text\/css/);
        expect(
          (await s3.head(this.blog.id + "/folder/e/style.txt")).contentType
        ).toMatch(/^text\/plain/);
        expect(await s3.head(this.blog.id + "/folder/e/empty/")).not.toBeNull();
      });

      it("uploads nothing below a file", async function () {
        await folder.write(this.blog.id, "/f", "file");

        expect(
          (await rejection(folder.write(this.blog.id, "/f/g.txt", "x"))).code
        ).toEqual("ENOTDIR");
        expect(await keys(this.blog.id)).toEqual([this.blog.id + "/folder/f"]);
      });

      it("leaves the index alone when the upload fails", async function () {
        var endpoint = config.storage.endpoint;

        await folder.write(this.blog.id, "/a.txt", "old");

        // nothing is listening on port 1
        config.storage.endpoint = "http://127.0.0.1:1";
        s3.reset();

        try {
          expect(
            await rejection(folder.write(this.blog.id, "/a.txt", "new!"))
          ).toBeDefined();
          expect(
            await rejection(folder.write(this.blog.id, "/b.txt", "new"))
          ).toBeDefined();
        } finally {
          config.storage.endpoint = endpoint;
          s3.reset();
        }

        expect((await File.get(this.blog.id, "/a.txt")).sha1).toEqual(
          sha1("old")
        );
        expect(await File.get(this.blog.id, "/b.txt")).toBeNull();
      }, 30000);

      it("reads metadata from the index, not from S3", async function () {
        await folder.write(this.blog.id, "/a.txt", "x");
        await s3.deleteKeys([this.blog.id + "/folder/a.txt"]);

        expect(await folder.exists(this.blog.id, "/a.txt")).toBe(true);
        expect(names(await folder.list(this.blog.id, "/"))).toEqual(["a.txt"]);
      });

      it("removes the folder's objects and index, but not the blog's assets", async function () {
        await folder.write(this.blog.id, "/a.txt", "x");
        await s3.putBuffer(this.blog.id + "/_assets/x.css", "x");

        await folder.removeAll(this.blog.id);

        expect(await keys(this.blog.id)).toEqual([]);
        expect(await s3.head(this.blog.id + "/_assets/x.css")).not.toBeNull();
        expect(await File.totals(this.blog.id)).toEqual({ bytes: 0, files: 0 });
      });
    });

    describe("the content cache", function () {
      var contentCache = require("storage/folder/cache");
      var maxFileBytes;

      beforeEach(function () {
        maxFileBytes = config.folder_cache.max_file_bytes;
      });

      afterEach(function () {
        config.folder_cache.max_file_bytes = maxFileBytes;
      });

      // Counts the downloads of one file's object
      function countGets(blogID, path) {
        var get = spyOn(s3, "get").and.callThrough();

        return function () {
          return get.calls.allArgs().filter(function (args) {
            return args[0] === blogID + "/folder" + path;
          }).length;
        };
      }

      // Drops the copies a blog's writes put in the cache, so the next read
      // has to download
      function forget(blogID) {
        return contentCache().removeBlog(blogID);
      }

      it("downloads a file once for ensureLocal, into the cache", async function () {
        await folder.write(this.blog.id, "/a.txt", "cached");
        await forget(this.blog.id);

        var gets = countGets(this.blog.id, "/a.txt");
        var first = await folder.ensureLocal(this.blog.id, "/a.txt");
        var second = await folder.ensureLocal(this.blog.id, "/a.txt");

        expect(second).toEqual(first);
        expect(first.indexOf(config.folder_cache.directory)).toEqual(0);
        expect(await fs.readFile(second, "utf8")).toEqual("cached");
        expect(gets()).toEqual(1);
      });

      it("reads from S3 when the cache's disk is full", async function () {
        await folder.write(this.blog.id, "/a.txt", "from S3");

        var full = Object.assign(new Error("no space left on device"), {
          code: "ENOSPC",
        });

        spyOn(contentCache(), "use").and.callFake(() => Promise.reject(full));

        expect((await folder.read(this.blog.id, "/a.txt")).toString()).toEqual(
          "from S3"
        );
      });

      it("reads and streams a small file from the cache after the first time", async function () {
        await folder.write(this.blog.id, "/a.txt", "0123456789");
        await forget(this.blog.id);

        var gets = countGets(this.blog.id, "/a.txt");

        expect((await folder.read(this.blog.id, "/a.txt")).toString()).toEqual(
          "0123456789"
        );
        expect((await folder.read(this.blog.id, "/a.txt")).toString()).toEqual(
          "0123456789"
        );
        expect(
          await slurp(
            folder.createReadStream(this.blog.id, "/a.txt", {
              start: 2,
              end: 4,
            })
          )
        ).toEqual("234");
        expect(
          await slurp(
            folder.createReadStream(this.blog.id, "/a.txt", { start: 50 })
          )
        ).toEqual("");
        expect(gets()).toEqual(1);
      });

      it("reads a file over the size limit straight from S3 each time", async function () {
        config.folder_cache.max_file_bytes = 2;

        await folder.write(this.blog.id, "/big.txt", "too big");

        var gets = countGets(this.blog.id, "/big.txt");

        expect(
          (await folder.read(this.blog.id, "/big.txt")).toString()
        ).toEqual("too big");
        expect(
          (await folder.read(this.blog.id, "/big.txt")).toString()
        ).toEqual("too big");
        expect(gets()).toEqual(2);
      });

      it("downloads the new version once a file changes", async function () {
        await folder.write(this.blog.id, "/a.txt", "one");
        await forget(this.blog.id);

        var gets = countGets(this.blog.id, "/a.txt");

        expect((await folder.read(this.blog.id, "/a.txt")).toString()).toEqual(
          "one"
        );

        await folder.write(this.blog.id, "/a.txt", "two");
        await forget(this.blog.id);

        expect((await folder.read(this.blog.id, "/a.txt")).toString()).toEqual(
          "two"
        );
        expect((await folder.read(this.blog.id, "/a.txt")).toString()).toEqual(
          "two"
        );
        expect(gets()).toEqual(2);
      });

      it("reads S3 directly when it holds bytes the index does not describe", async function () {
        await folder.write(this.blog.id, "/a.txt", "old");
        await forget(this.blog.id);

        // As if a write had reached S3 but not yet the index
        await s3.putBuffer(this.blog.id + "/folder/a.txt", Buffer.from("new"));

        expect((await folder.read(this.blog.id, "/a.txt")).toString()).toEqual(
          "new"
        );
        expect(
          (await rejection(folder.ensureLocal(this.blog.id, "/a.txt"))).code
        ).toEqual("ECHANGED");
      });

      it("removes the blog's cached copies with its folder", async function () {
        await folder.write(this.blog.id, "/a.txt", "x");

        var local = await folder.ensureLocal(this.blog.id, "/a.txt");

        await folder.removeAll(this.blog.id);

        expect(await fs.pathExists(local)).toBe(false);
      });

      it("counts hits and misses", async function () {
        await folder.write(this.blog.id, "/a.txt", "x");
        await forget(this.blog.id);

        var before = contentCache().stats();

        await folder.read(this.blog.id, "/a.txt");
        await folder.read(this.blog.id, "/a.txt");

        var after = contentCache().stats();

        expect(after.misses - before.misses).toEqual(1);
        expect(after.hits - before.hits).toEqual(1);
      });

      describe("filled by writes", function () {
        var tmp;

        beforeEach(async function () {
          await fs.ensureDir(config.tmp_directory);
          tmp = await fs.mkdtemp(
            join(config.tmp_directory, "storage-folder-write-through-")
          );
        });

        afterEach(async function () {
          await fs.remove(tmp);
        });

        function filled() {
          return contentCache().stats().filled;
        }

        it("makes a read straight after a write of a Buffer, a string or a stream a hit", async function () {
          var blogID = this.blog.id;
          var before = contentCache().stats();
          var get = spyOn(s3, "get").and.callThrough();

          await folder.write(blogID, "/buffer.txt", Buffer.from("buffer"));
          await folder.write(blogID, "/string.txt", "string");
          await folder.write(
            blogID,
            "/stream.txt",
            Readable.from([Buffer.from("str"), Buffer.from("eam")])
          );

          expect((await folder.read(blogID, "/buffer.txt")).toString()).toEqual(
            "buffer"
          );
          expect((await folder.read(blogID, "/string.txt")).toString()).toEqual(
            "string"
          );
          expect(
            await slurp(folder.createReadStream(blogID, "/stream.txt"))
          ).toEqual("stream");
          expect(
            await fs.readFile(
              await folder.ensureLocal(blogID, "/stream.txt"),
              "utf8"
            )
          ).toEqual("stream");

          var after = contentCache().stats();

          expect(get).not.toHaveBeenCalled();
          expect(after.filled - before.filled).toEqual(3);
          expect(after.misses - before.misses).toEqual(0);
          expect(after.fetchedBytes - before.fetchedBytes).toEqual(0);
        });

        it("makes a read straight after writeFrom a hit, for a copy and a move", async function () {
          var copied = join(tmp, "copied.txt");
          var moved = join(tmp, "moved.txt");

          await fs.writeFile(copied, "copied");
          await fs.writeFile(moved, "moved");

          var get = spyOn(s3, "get").and.callThrough();

          await folder.writeFrom(this.blog.id, "/copied.txt", copied);
          await folder.writeFrom(this.blog.id, "/moved.txt", moved, {
            move: true,
          });

          expect(await fs.pathExists(copied)).toBe(true);
          expect(await fs.pathExists(moved)).toBe(false);
          expect(
            (await folder.read(this.blog.id, "/copied.txt")).toString()
          ).toEqual("copied");
          expect(
            (await folder.read(this.blog.id, "/moved.txt")).toString()
          ).toEqual("moved");
          expect(get).not.toHaveBeenCalled();
        });

        it("makes a read straight after a commit a hit", async function () {
          var staged = await folder.path(this.blog.id, "/tool.txt");

          await fs.outputFile(staged, "from a tool");

          var get = spyOn(s3, "get").and.callThrough();

          await folder.commit(this.blog.id, "/tool.txt");

          expect(
            (await folder.read(this.blog.id, "/tool.txt")).toString()
          ).toEqual("from a tool");
          expect(get).not.toHaveBeenCalled();
        });

        it("serves the new bytes after an overwrite", async function () {
          var source = join(tmp, "three.txt");
          var gets = countGets(this.blog.id, "/a.txt");

          await folder.write(this.blog.id, "/a.txt", "one");
          expect(
            (await folder.read(this.blog.id, "/a.txt")).toString()
          ).toEqual("one");

          await folder.write(this.blog.id, "/a.txt", "two");
          expect(
            (await folder.read(this.blog.id, "/a.txt")).toString()
          ).toEqual("two");

          await fs.writeFile(source, "three");
          await folder.writeFrom(this.blog.id, "/a.txt", source);
          expect(
            (await folder.read(this.blog.id, "/a.txt")).toString()
          ).toEqual("three");

          expect(gets()).toEqual(0);
        });

        it("does not fill the cache with a file over the size limit", async function () {
          config.folder_cache.max_file_bytes = 2;

          var before = filled();
          var source = join(tmp, "big.txt");

          await fs.writeFile(source, "too big");
          await folder.write(this.blog.id, "/big.txt", "too big");
          await folder.write(
            this.blog.id,
            "/big-stream.txt",
            Readable.from([Buffer.from("too big")])
          );
          await folder.writeFrom(this.blog.id, "/big-copy.txt", source);

          expect(filled()).toEqual(before);

          // ensureLocal, which caches any size, downloads it
          var gets = countGets(this.blog.id, "/big.txt");

          expect(
            await fs.readFile(
              await folder.ensureLocal(this.blog.id, "/big.txt"),
              "utf8"
            )
          ).toEqual("too big");
          expect(gets()).toEqual(1);
        });

        it("still writes when the cache fails, and the read downloads", async function () {
          var full = Object.assign(new Error("no space left on device"), {
            code: "ENOSPC",
          });
          var source = join(tmp, "moved.txt");
          var put = spyOn(contentCache(), "put").and.callFake(() =>
            Promise.reject(full)
          );

          spyOn(console, "error");

          await fs.writeFile(source, "moved");

          await folder.write(this.blog.id, "/a.txt", "buffer");
          await folder.write(
            this.blog.id,
            "/b.txt",
            Readable.from([Buffer.from("stream")])
          );
          await folder.writeFrom(this.blog.id, "/c.txt", source, {
            move: true,
          });

          expect(put.calls.count()).toEqual(3);
          expect(await fs.pathExists(source)).toBe(false);
          expect((await File.get(this.blog.id, "/c.txt")).sha1).toEqual(
            sha1("moved")
          );

          var gets = countGets(this.blog.id, "/a.txt");

          expect(
            (await folder.read(this.blog.id, "/a.txt")).toString()
          ).toEqual("buffer");
          expect(
            (await folder.read(this.blog.id, "/b.txt")).toString()
          ).toEqual("stream");
          expect(
            (await folder.read(this.blog.id, "/c.txt")).toString()
          ).toEqual("moved");
          expect(gets()).toEqual(1);
        });

        it("caches nothing when the source changes after its upload", async function () {
          var source = join(tmp, "source.txt");
          var upload = s3.uploadFile;

          await fs.writeFile(source, "uploaded");

          // As if the source was rewritten while it was being uploaded
          spyOn(s3, "uploadFile").and.callFake(async function () {
            var uploaded = await upload.apply(s3, arguments);
            await fs.writeFile(source, "rewritten");
            return uploaded;
          });

          var before = filled();

          await folder.writeFrom(this.blog.id, "/a.txt", source);

          expect(filled()).toEqual(before);

          var gets = countGets(this.blog.id, "/a.txt");

          expect(
            (await folder.read(this.blog.id, "/a.txt")).toString()
          ).toEqual("uploaded");
          expect(gets()).toEqual(1);
        });
      });

      describe("when serving", function () {
        var state = {};

        useServer(state);

        it("serves a small file from the cache, with validators from the index", async function () {
          await folder.write(state.blogID, "/a.txt", "hello");
          await forget(state.blogID);

          var gets = countGets(state.blogID, "/a.txt");
          var open = spyOn(s3, "open").and.callThrough();

          var first = await fetch(state.origin + "/a.txt");
          var second = await fetch(state.origin + "/a.txt", {
            headers: { "If-None-Match": first.headers.get("etag") },
          });

          expect(await first.text()).toEqual("hello");
          expect(first.headers.get("etag")).toEqual('"' + sha1("hello") + '"');
          expect(second.status).toEqual(304);
          expect(gets()).toEqual(1);
          expect(open).not.toHaveBeenCalled();
        });

        it("serves a cached file with no extension as HTML, as S3 would", async function () {
          await folder.write(state.blogID, "/page", "<p>hello</p>");

          var res = await fetch(state.origin + "/page");

          expect(await res.text()).toEqual("<p>hello</p>");
          expect(res.headers.get("content-type")).toMatch(/^text\/html/);
        });

        it("streams a file over the size limit from S3", async function () {
          config.folder_cache.max_file_bytes = 2;

          await folder.write(state.blogID, "/big.txt", "too big");

          var open = spyOn(s3, "open").and.callThrough();
          var res = await fetch(state.origin + "/big.txt");

          expect(await res.text()).toEqual("too big");
          expect(open).toHaveBeenCalled();
        });
      });
    });

    describe("path and commit", function () {
      it("stages a tool's file in the tmp directory and uploads it on commit", async function () {
        var place = await folder.path(this.blog.id, "/tool/out.txt");

        expect(place.indexOf(config.tmp_directory)).toEqual(0);

        await fs.outputFile(place, "from a tool");
        await folder.commit(this.blog.id, "/tool/out.txt");

        expect(await fs.pathExists(place)).toBe(false);
        expect((await File.get(this.blog.id, "/tool/out.txt")).sha1).toEqual(
          sha1("from a tool")
        );
      });
    });

    describe("case-only siblings", function () {
      it("picks the first in sorted order when none is exact", async function () {
        await folder.write(this.blog.id, "/templates/a.txt", "lower");
        await folder.write(this.blog.id, "/Templates/a.txt", "upper");

        expect(
          await folder.resolveCaseInsensitive(this.blog.id, "/TEMPLATES/a.txt")
        ).toEqual("/Templates/a.txt");
      });
    });

    describe("rebuilding the index", function () {
      it("rebuilds it from a listing of the bucket", async function () {
        await folder.write(this.blog.id, "/a/b.txt", "hello");
        await folder.write(this.blog.id, "/c.txt", "cc");
        await folder.mkdir(this.blog.id, "/empty");

        var before = await collect(
          folder.walk(this.blog.id, "/", { directories: true })
        );
        var record = await File.get(this.blog.id, "/a/b.txt");

        await File.removeAll(this.blog.id);

        var counts = await backend.rebuildIndex(this.blog.id, { hash: true });

        expect(counts).toEqual({ files: 2, dirs: 2, bytes: 7, skipped: [] });
        expect(
          await collect(folder.walk(this.blog.id, "/", { directories: true }))
        ).toEqual(before);
        expect((await File.get(this.blog.id, "/a/b.txt")).sha1).toEqual(
          record.sha1
        );
      });

      it("keeps the flags of files whose bytes are unchanged", async function () {
        await folder.writePlaceholder(this.blog.id, "/big.mov", {
          code: "SYNC_TOO_LARGE",
          size: 200,
          limit: 100,
        });
        await folder.write(this.blog.id, "/a.md", "# Hi");
        await folder.setFlags(this.blog.id, "/a.md", "build", [
          { code: "BUILD_FAILED" },
        ]);

        await backend.rebuildIndex(this.blog.id);

        expect((await folder.stat(this.blog.id, "/big.mov")).placeholder).toBe(
          true
        );
        expect((await folder.stat(this.blog.id, "/a.md")).flags).toEqual([
          { code: "BUILD_FAILED" },
        ]);
      });

      it("keeps apart downloads of same-named files when there are no hashes", async function () {
        await folder.write(this.blog.id, "/one/a.txt", "1");
        await folder.write(this.blog.id, "/two/a.txt", "2");

        // As a rebuild without hashing leaves them: same name, size and time
        for (var path of ["/one/a.txt", "/two/a.txt"]) {
          await File.set(this.blog.id, path, {
            type: "file",
            size: 1,
            modified: 5,
            sha1: "",
          });
        }

        expect(
          await fs.readFile(
            await folder.ensureLocal(this.blog.id, "/one/a.txt"),
            "utf8"
          )
        ).toEqual("1");
        expect(
          await fs.readFile(
            await folder.ensureLocal(this.blog.id, "/two/a.txt"),
            "utf8"
          )
        ).toEqual("2");
      });

      it("leaves hashes out unless asked", async function () {
        await folder.write(this.blog.id, "/a.txt", "x");

        await backend.rebuildIndex(this.blog.id);

        expect((await File.get(this.blog.id, "/a.txt")).sha1).toEqual("");
        expect(
          (await folder.stat(this.blog.id, "/a.txt", { sha1: true })).sha1
        ).toEqual(sha1("x"));
        expect((await folder.read(this.blog.id, "/a.txt")).toString()).toEqual(
          "x"
        );
        expect(
          await fs.readFile(
            await folder.ensureLocal(this.blog.id, "/a.txt"),
            "utf8"
          )
        ).toEqual("x");
      });
    });
  });
});
