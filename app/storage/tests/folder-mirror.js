// Mirroring of storage/folder's changes on disk into the S3 backend
// (app/storage/folder/mirror.js, #2258 Phase C), on MinIO. The local backend
// stays current throughout: every read in the app still comes from disk.
describe("storage/folder mirror", function () {
  var config = require("config");
  var crypto = require("crypto");
  var fs = require("fs-extra");
  var { join } = require("path");
  var { Readable } = require("stream");
  var folder = require("storage/folder");
  var local = require("storage/folder/local");
  var backend = require("storage/folder/s3");
  var mirror = require("storage/folder/mirror");
  var s3 = require("storage/s3");
  var File = require("models/file");
  var client = require("models/client");

  global.test.blog();

  require("./minio")();

  var saved;
  var tmp;

  beforeEach(async function () {
    saved = config.folder_mirror;
    config.folder_mirror = this.blog.id;
    // On the same filesystem as the blog folders, so a move in is a rename
    // which keeps the file's modified time
    await fs.ensureDir(config.tmp_directory);
    tmp = await fs.mkdtemp(join(config.tmp_directory, "folder-mirror-"));
  });

  afterEach(async function () {
    config.folder_mirror = saved;
    await fs.remove(tmp);
    await client.sRem(mirror.DIRTY_KEY, this.blog.id);
  });

  function down() {
    return Promise.reject(new Error("S3 is down"));
  }

  function sha1(data) {
    return crypto.createHash("sha1").update(data).digest("hex");
  }

  // Every path in a backend's copy of the folder, with what a reader sees
  async function tree(store, blogID) {
    var found = {};

    for await (var path of store.walk(blogID, "/", { directories: true })) {
      var stat = await store.stat(blogID, path, { sha1: true });

      found[path] = stat.isDirectory ? "dir" : [stat.size, Math.round(stat.modified), stat.sha1];
    }

    return found;
  }

  async function keys(blogID) {
    var found = [];
    for await (var entry of s3.listEntries(backend.root(blogID))) found.push(entry.key.slice(backend.root(blogID).length - 1));
    return found.sort();
  }

  async function expectMirrored(blogID) {
    expect(await tree(backend, blogID)).toEqual(await tree(local, blogID));
  }

  async function isDirty(blogID) {
    return !!(await client.sIsMember(mirror.DIRTY_KEY, blogID));
  }

  describe("when on", function () {
    it("mirrors buffers, strings and nested paths", async function () {
      await folder.write(this.blog.id, "/a.txt", "hello");
      await folder.write(this.blog.id, "/posts/2024/b.md", Buffer.from("# Title"));

      await expectMirrored(this.blog.id);
      expect((await backend.read(this.blog.id, "/posts/2024/b.md")).toString()).toEqual("# Title");
      expect(await keys(this.blog.id)).toEqual(["/a.txt", "/posts/2024/b.md"]);
    });

    it("mirrors a stream from the file on disk, with its SHA-1 and modified time", async function () {
      var body = crypto.randomBytes(256 * 1024);

      await folder.write(this.blog.id, "/big.bin", Readable.from([body.subarray(0, 1000), body.subarray(1000)]));

      var record = await File.get(this.blog.id, "/big.bin");
      var stat = await local.stat(this.blog.id, "/big.bin");

      expect(record.size).toEqual(body.length);
      expect(record.sha1).toEqual(sha1(body));
      expect(record.modified).toEqual(Math.round(stat.modified));
      expect((await backend.read(this.blog.id, "/big.bin")).equals(body)).toBe(true);
    });

    // So the shadow reads see the hit rate a blog on S3 would
    it("fills the S3 backend's content cache, so a read of S3 after a write costs no GET", async function () {
      var contentCache = require("storage/folder/cache");
      var before = contentCache().stats();
      var source = join(tmp, "moved.txt");
      var get = spyOn(s3, "get").and.callThrough();

      await fs.writeFile(source, "moved");

      await folder.write(this.blog.id, "/a.txt", "written");
      await folder.write(this.blog.id, "/s.txt", Readable.from(["streamed"]));
      await folder.writeFrom(this.blog.id, "/m.txt", source, { move: true });

      expect((await backend.read(this.blog.id, "/a.txt")).toString()).toEqual("written");
      expect((await backend.read(this.blog.id, "/s.txt")).toString()).toEqual("streamed");
      expect((await backend.read(this.blog.id, "/m.txt")).toString()).toEqual("moved");
      expect(get).not.toHaveBeenCalled();
      expect(contentCache().stats().filled - before.filled).toEqual(3);
    });

    it("mirrors a copy in, keeping the source", async function () {
      var source = join(tmp, "copy.txt");

      await fs.writeFile(source, "copied");
      await folder.writeFrom(this.blog.id, "/copy.txt", source);

      expect(await fs.pathExists(source)).toBe(true);
      await expectMirrored(this.blog.id);
    });

    it("mirrors a move in, with the moved file's modified time", async function () {
      var source = join(tmp, "moved.txt");
      var then = new Date("2020-01-02T03:04:05Z");

      await fs.writeFile(source, "moved");
      await fs.utimes(source, then, then);
      await folder.writeFrom(this.blog.id, "/in/moved.txt", source, { move: true });

      expect(await fs.pathExists(source)).toBe(false);

      var record = await File.get(this.blog.id, "/in/moved.txt");

      // The time the file has on disk: the source's, when the move is a
      // rename (fs-extra may copy across filesystems)
      expect(record.modified).toEqual(Math.round((await local.stat(this.blog.id, "/in/moved.txt")).modified));
      expect(record.sha1).toEqual(sha1("moved"));
      await expectMirrored(this.blog.id);
    });

    it("mirrors an empty directory as a marker", async function () {
      await folder.mkdir(this.blog.id, "/empty");

      expect((await File.get(this.blog.id, "/empty")).type).toEqual("dir");
      expect(await keys(this.blog.id)).toEqual(["/empty/"]);
      await expectMirrored(this.blog.id);
    });

    it("mirrors removes of files and directories", async function () {
      await folder.write(this.blog.id, "/a.txt", "a");
      await folder.write(this.blog.id, "/dir/b.txt", "b");
      await folder.write(this.blog.id, "/other/c.txt", "c");

      await folder.remove(this.blog.id, "/a.txt");
      await folder.remove(this.blog.id, "/dir");
      await folder.rmdir(this.blog.id, "/other");

      expect(await keys(this.blog.id)).toEqual([]);
      await expectMirrored(this.blog.id);
    });

    it("mirrors moves of files and directories", async function () {
      await folder.write(this.blog.id, "/a.txt", "a");
      await folder.write(this.blog.id, "/dir/b.txt", "b");
      await folder.write(this.blog.id, "/dir/sub/c.txt", "c");

      await folder.move(this.blog.id, "/a.txt", "/renamed/a.txt");
      await folder.move(this.blog.id, "/dir", "/moved");

      expect(await keys(this.blog.id)).toEqual(["/moved/b.txt", "/moved/sub/c.txt", "/renamed/a.txt"]);
      await expectMirrored(this.blog.id);
    });

    it("uploads the destination of a move which S3 does not have yet", async function () {
      config.folder_mirror = "off";
      await folder.write(this.blog.id, "/before/a.txt", "written before mirroring");
      config.folder_mirror = this.blog.id;

      await folder.move(this.blog.id, "/before", "/after");

      expect(await keys(this.blog.id)).toEqual(["/after/a.txt"]);
      await expectMirrored(this.blog.id);
      expect(await isDirty(this.blog.id)).toBe(false);
    });

    it("mirrors what a tool wrote to path() on commit", async function () {
      var file = await folder.path(this.blog.id, "/out/tool.txt");

      await fs.outputFile(file, "from a tool");
      await folder.commit(this.blog.id, "/out/tool.txt");

      expect(await keys(this.blog.id)).toEqual(["/out/tool.txt"]);
      await expectMirrored(this.blog.id);
    });

    it("mirrors blog deletion", async function () {
      await folder.write(this.blog.id, "/a/b.txt", "b");
      await client.sAdd(mirror.DIRTY_KEY, this.blog.id);

      await folder.removeAll(this.blog.id);

      expect(await keys(this.blog.id)).toEqual([]);
      expect(await File.totals(this.blog.id)).toEqual({ bytes: 0, files: 0 });
      expect(await isDirty(this.blog.id)).toBe(false);
    });

    it("deletes the copy of a deleted blog which is no longer mirrored", async function () {
      await folder.write(this.blog.id, "/a.txt", "a");
      config.folder_mirror = "off";

      await folder.removeAll(this.blog.id);

      expect(await keys(this.blog.id)).toEqual([]);
    });

    it("deletes the copy of a deleted blog the index doesn't know of, when the blog is marked", async function () {
      await folder.write(this.blog.id, "/a.txt", "a");

      // As a failed index write leaves it: the object in S3, no index, a flag
      await File.removeAll(this.blog.id);
      await client.sAdd(mirror.DIRTY_KEY, this.blog.id);
      config.folder_mirror = "off";

      await folder.removeAll(this.blog.id);

      expect(await keys(this.blog.id)).toEqual([]);
      expect(await isDirty(this.blog.id)).toBe(false);
    });

    it("keeps the disk's change and marks the blog when S3 fails", async function () {
      spyOn(s3, "uploadFile").and.callFake(down);
      spyOn(console, "error");

      await folder.write(this.blog.id, "/a.txt", "on disk");

      expect((await folder.read(this.blog.id, "/a.txt")).toString()).toEqual("on disk");
      expect(await File.get(this.blog.id, "/a.txt")).toBe(null);
      expect(await isDirty(this.blog.id)).toBe(true);

      var logged = console.error.calls.allArgs().map(function (args) {
        return args.join(" ");
      });

      expect(
        logged.some(function (line) {
          return (
            line.indexOf(mirror.LOG_PREFIX) !== -1 &&
            line.indexOf("blog=" + this.blog.id) !== -1 &&
            line.indexOf("op=write") !== -1 &&
            line.indexOf("S3 is down") !== -1
          );
        }, this)
      ).toBe(true);
    });

    it("keeps a remove on disk when S3 fails", async function () {
      await folder.write(this.blog.id, "/a.txt", "a");

      spyOn(s3, "deleteKeys").and.callFake(down);
      spyOn(console, "error");

      await folder.remove(this.blog.id, "/a.txt");

      expect(await folder.exists(this.blog.id, "/a.txt")).toBe(false);
      expect(await isDirty(this.blog.id)).toBe(true);
    });

    it("does nothing in S3 without a bucket, and the write still succeeds", async function () {
      var bucket = config.storage.bucket;

      spyOn(s3, "uploadFile").and.callThrough();
      spyOn(console, "error");

      config.storage.bucket = "";

      try {
        await folder.write(this.blog.id, "/a.txt", "a");
      } finally {
        config.storage.bucket = bucket;
      }

      expect((await folder.read(this.blog.id, "/a.txt")).toString()).toEqual("a");
      expect(s3.uploadFile).not.toHaveBeenCalled();
      expect(await isDirty(this.blog.id)).toBe(false);
    });

    it("mirrors only the blogs it names", async function () {
      config.folder_mirror = "blog_someoneelse, blog_another";

      await folder.write(this.blog.id, "/a.txt", "a");

      expect(await keys(this.blog.id)).toEqual([]);

      config.folder_mirror = "blog_someoneelse," + this.blog.id;

      await folder.write(this.blog.id, "/b.txt", "b");

      expect(await keys(this.blog.id)).toEqual(["/b.txt"]);

      config.folder_mirror = "all";

      await folder.write(this.blog.id, "/c.txt", "c");

      expect(await keys(this.blog.id)).toEqual(["/b.txt", "/c.txt"]);
    });
  });

  describe("when off", function () {
    beforeEach(function () {
      config.folder_mirror = "off";
    });

    it("makes no S3 calls", async function () {
      var calls = ["uploadFile", "putBuffer", "copy", "deleteKeys", "get", "head"].map(function (name) {
        return spyOn(s3, name).and.callThrough();
      });
      var source = join(tmp, "moved.txt");

      await fs.writeFile(source, "moved");

      await folder.write(this.blog.id, "/a.txt", "a");
      await folder.write(this.blog.id, "/s.txt", Readable.from(["stream"]));
      await folder.writeFrom(this.blog.id, "/m.txt", source, { move: true });
      await folder.mkdir(this.blog.id, "/empty");
      await folder.move(this.blog.id, "/a.txt", "/b.txt");
      await folder.remove(this.blog.id, "/b.txt");
      await folder.rmdir(this.blog.id, "/empty");

      calls.forEach(function (spy) {
        expect(spy).not.toHaveBeenCalled();
      });

      expect(await File.get(this.blog.id, "/s.txt")).toBe(null);
      expect(await keys(this.blog.id)).toEqual([]);
    });
  });
});
