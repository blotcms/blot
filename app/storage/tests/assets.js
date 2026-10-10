describe("storage/assets", function () {
  global.test.blog();
  global.test.tmp();

  var assets = require("storage/assets");
  var s3 = require("storage/s3");
  var config = require("config");
  var fs = require("fs-extra");
  var join = require("path").join;
  var { PutObjectCommand } = require("@aws-sdk/client-s3");
  var useBucket = require("./minio");

  // Each spec gets an empty bucket of its own
  useBucket();

  var STAGING = join(config.tmp_directory, "storage-assets-staging");

  // Puts an object straight into the bucket, bypassing staging
  async function putS3(blogID, relPath, data) {
    await s3.client().send(
      new PutObjectCommand({
        Bucket: config.storage.bucket,
        Key: blogID + "/" + relPath,
        Body: Buffer.from(data),
      })
    );
  }

  // Writes a file to the staging directory without committing it
  async function stage(blogID, relPath, data) {
    await fs.outputFile(assets.path(blogID, relPath), data);
  }

  async function bodyOf(blogID, relPath) {
    var data = await s3.get(blogID + "/" + relPath);
    return Buffer.from(await data.Body.transformToByteArray()).toString();
  }

  async function keys(prefix) {
    var found = [];
    for await (var entry of s3.listEntries(prefix)) found.push(entry.key);
    return found.sort();
  }

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

  describe("path", function () {
    it("joins a staging path for the blog's asset directory under the tmp directory", function () {
      var test = this;

      expect(assets.path(test.blog.id, "_thumbnails", "foo.jpg")).toEqual(
        join(STAGING, test.blog.id, "_thumbnails", "foo.jpg")
      );
    });

    it("returns the blog's staging directory when called with no segments", function () {
      var test = this;

      expect(assets.path(test.blog.id)).toEqual(join(STAGING, test.blog.id));
    });

    it("rejects a path which escapes the blog's asset directory", function () {
      var test = this;

      expect(function () {
        assets.path(test.blog.id, "../x");
      }).toThrow();

      expect(function () {
        assets.path(test.blog.id, "../../");
      }).toThrow();
    });

    it("rejects a blogID which is not a non-empty string or is a path", function () {
      expect(function () {
        assets.path("", "x");
      }).toThrow();

      expect(function () {
        assets.path(undefined, "x");
      }).toThrow();

      expect(function () {
        assets.path("..", "x");
      }).toThrow();

      expect(function () {
        assets.path("blog_a/../../x", "x");
      }).toThrow();
    });
  });

  describe("relPath arguments", function () {
    it("accept a leading slash and reject paths which escape", async function () {
      var test = this;

      await assets.write(test.blog.id, "/_thumbnails/a.txt", "a");
      expect(await bodyOf(test.blog.id, "_thumbnails/a.txt")).toEqual("a");

      var calls = [
        function () { return assets.url(test.blog.id, "/../x"); },
        function () { return assets.commit(test.blog.id, "../x"); },
        function () { return assets.write(test.blog.id, "/../x", "x"); },
        function () { return assets.writeFrom(test.blog.id, "../x", __filename); },
        function () { return assets.read(test.blog.id, "/../../x"); },
        function () { return assets.exists(test.blog.id, "../x"); },
        function () { return assets.list(test.blog.id, "../"); },
        function () { return assets.ensureLocal(test.blog.id, "../x"); },
        function () { return assets.remove(test.blog.id, "../x"); },
        function () { return assets.createReadStream(test.blog.id, "../x"); },
      ];

      for (var call of calls) {
        var rejected = false;
        try {
          await call();
        } catch (err) {
          rejected = /escapes/.test(err.message);
        }
        expect(rejected).toBe(true);
      }
    });
  });

  describe("url", function () {
    it("builds the public CDN URL", function () {
      var test = this;
      var expected = config.cdn.origin + "/" + test.blog.id + "/_thumbnails/x/small.jpg";

      expect(assets.url(test.blog.id, "_thumbnails/x/small.jpg")).toEqual(expected);
      expect(assets.url(test.blog.id, "/_thumbnails/x/small.jpg")).toEqual(expected);
    });

    it("does not encode the name it is given", function () {
      var test = this;

      expect(assets.url(test.blog.id, "_template_assets/a%20b.png")).toEqual(
        config.cdn.origin + "/" + test.blog.id + "/_template_assets/a%20b.png"
      );
    });
  });

  describe("write and read", function () {
    it("writes a string to the bucket, leaving nothing staged", async function () {
      var test = this;

      await assets.write(test.blog.id, "_assets/doc/a.txt", "hello");

      expect(await bodyOf(test.blog.id, "_assets/doc/a.txt")).toEqual("hello");
      expect(await fs.pathExists(assets.path(test.blog.id, "_assets/doc/a.txt"))).toBe(false);
      expect(await fs.pathExists(assets.path(test.blog.id, "_assets/doc"))).toBe(false);
    });

    it("writes and reads a Buffer", async function () {
      var test = this;
      var data = Buffer.from([0, 1, 2, 255]);

      await assets.write(test.blog.id, "_avatars/a.bin", data);
      var read = await assets.read(test.blog.id, "_avatars/a.bin");

      expect(Buffer.isBuffer(read)).toBe(true);
      expect(read.equals(data)).toBe(true);
    });

    it("replaces an existing object", async function () {
      var test = this;

      await assets.write(test.blog.id, "_assets/a.txt", "old");
      await assets.write(test.blog.id, "_assets/a.txt", "new");

      expect(await assets.read(test.blog.id, "_assets/a.txt")).toEqual(Buffer.from("new"));
    });

    it("reads an object which was never staged here", async function () {
      await putS3(this.blog.id, "_assets/s3.txt", "s3");

      expect((await assets.read(this.blog.id, "_assets/s3.txt")).toString()).toEqual("s3");
    });

    it("read throws NotFoundError when the file is missing", async function () {
      var test = this;
      var error = await rejection(assets.read(test.blog.id, "_avatars/missing.png"));

      expect(error instanceof assets.NotFoundError).toBe(true);
      expect(error.code).toEqual("ENOENT");
    });

    it("does not read a file which is only staged", async function () {
      var test = this;

      await stage(test.blog.id, "_avatars/staged.png", "staged");

      expect((await rejection(assets.read(test.blog.id, "_avatars/staged.png"))) instanceof assets.NotFoundError).toBe(true);
      expect(await assets.exists(test.blog.id, "_avatars/staged.png")).toBe(false);
    });
  });

  describe("commit", function () {
    it("uploads a file with its content type and a year of caching", async function () {
      var test = this;

      await stage(test.blog.id, "_thumbnails/x/small.png", "png-bytes");
      await assets.commit(test.blog.id, "_thumbnails/x/small.png");

      var object = await s3.head(test.blog.id + "/_thumbnails/x/small.png");

      expect(object.size).toEqual(9);
      expect(object.contentType).toEqual("image/png");
      expect(object.cacheControl).toEqual("public, max-age=31536000, immutable");
      expect(await bodyOf(test.blog.id, "_thumbnails/x/small.png")).toEqual("png-bytes");
    });

    it("types unknown extensions as octet-stream and mp4 as video", async function () {
      var test = this;

      await stage(test.blog.id, "_assets/a.unknownext", "a");
      await stage(test.blog.id, "_assets/b.mp4", "b");
      await assets.commit(test.blog.id, "_assets");

      expect((await s3.head(test.blog.id + "/_assets/a.unknownext")).contentType).toEqual(
        "application/octet-stream"
      );
      expect((await s3.head(test.blog.id + "/_assets/b.mp4")).contentType).toEqual("video/mp4");
    });

    it("uploads every file in a directory", async function () {
      var test = this;
      var expected = [];

      for (var i = 0; i < 20; i++) {
        var relPath = "_assets/doc/media/" + (i % 2 ? "odd/" : "") + "image" + i + ".jpg";
        await stage(test.blog.id, relPath, "image " + i);
        expected.push(test.blog.id + "/" + relPath);
      }

      await assets.commit(test.blog.id, "_assets/doc");

      expect(await keys(test.blog.id + "/")).toEqual(expected.sort());
      expect(await bodyOf(test.blog.id, "_assets/doc/media/odd/image7.jpg")).toEqual("image 7");
    });

    it("waits for uploads in flight before failing a directory, and still cleans up staging", async function () {
      var test = this;
      var upload = s3.upload;
      var inFlight = 0;
      var started = 0;

      for (var i = 0; i < 24; i++) {
        await stage(test.blog.id, "_assets/doc/file" + i + ".txt", "file " + i);
      }

      spyOn(s3, "upload").and.callFake(async function () {
        var n = ++started;

        inFlight++;

        try {
          await new Promise(function (resolve) {
            setTimeout(resolve, n === 1 ? 10 : 150);
          });

          if (n === 1) throw new Error("upload failed");

          return await upload.apply(s3, arguments);
        } finally {
          inFlight--;
        }
      });

      var err = await rejection(assets.commit(test.blog.id, "_assets/doc"));
      var inFlightWhenRejected = inFlight;

      expect(err && err.message).toEqual("upload failed");
      expect(inFlightWhenRejected).toEqual(0);
      // it stopped starting uploads once one had failed
      expect(started).toBeLessThan(24);
      expect(started).toBeGreaterThan(1);
      // and every staged file is gone, uploaded or not
      expect(await fs.pathExists(assets.path(test.blog.id, "_assets/doc"))).toBe(false);
    });

    it("does nothing when there's nothing at the path", async function () {
      await assets.commit(this.blog.id, "_assets/nothing");

      expect(await keys(this.blog.id + "/")).toEqual([]);
    });

    it("deletes the staged file once it is uploaded, and the directories it emptied", async function () {
      var test = this;

      await stage(test.blog.id, "_thumbnails/x/a.jpg", "a");
      await assets.commit(test.blog.id, "_thumbnails/x/a.jpg");

      expect(await assets.exists(test.blog.id, "_thumbnails/x/a.jpg")).toBe(true);
      expect(await fs.pathExists(assets.path(test.blog.id, "_thumbnails/x/a.jpg"))).toBe(false);
      expect(await fs.pathExists(assets.path(test.blog.id, "_thumbnails/x"))).toBe(false);
    });

    it("deletes every staged file of a directory, and the directories it emptied", async function () {
      var test = this;

      await stage(test.blog.id, "_assets/doc/media/a.png", "a");
      await stage(test.blog.id, "_assets/doc/media/deep/b.png", "b");
      await assets.commit(test.blog.id, "_assets/doc");

      expect(await assets.exists(test.blog.id, "_assets/doc/media/a.png")).toBe(true);
      expect(await assets.exists(test.blog.id, "_assets/doc/media/deep/b.png")).toBe(true);
      expect(await fs.pathExists(assets.path(test.blog.id, "_assets/doc"))).toBe(false);
    });

    it("deletes only the files it uploaded: another file staged in the same directory survives", async function () {
      var test = this;

      await stage(test.blog.id, "_assets/shared/mine.png", "mine");
      await stage(test.blog.id, "_assets/shared/theirs.png", "theirs");
      await assets.commit(test.blog.id, "_assets/shared/mine.png");

      expect(await assets.exists(test.blog.id, "_assets/shared/mine.png")).toBe(true);
      expect(await assets.exists(test.blog.id, "_assets/shared/theirs.png")).toBe(false);
      expect(await fs.pathExists(assets.path(test.blog.id, "_assets/shared/mine.png"))).toBe(false);
      expect(await fs.readFile(assets.path(test.blog.id, "_assets/shared/theirs.png"), "utf-8")).toEqual("theirs");

      // and it can still be committed afterwards
      await assets.commit(test.blog.id, "_assets/shared/theirs.png");

      expect(await bodyOf(test.blog.id, "_assets/shared/theirs.png")).toEqual("theirs");
    });

    it("keeps a blog's top-level staging directories, which other builds may be about to write into", async function () {
      var test = this;

      await stage(test.blog.id, "_bookmark_screenshots/a.png", "a");
      await assets.commit(test.blog.id, "_bookmark_screenshots/a.png");

      expect(await fs.pathExists(assets.path(test.blog.id, "_bookmark_screenshots"))).toBe(true);
    });

    it("tolerates a file another commit has already taken", async function () {
      var test = this;

      for (var i = 0; i < 12; i++) await stage(test.blog.id, "_assets/doc/" + i + ".png", "x" + i);

      await Promise.all([
        assets.commit(test.blog.id, "_assets/doc"),
        assets.commit(test.blog.id, "_assets/doc"),
      ]);

      expect((await keys(test.blog.id + "/")).length).toEqual(12);
      expect(await fs.pathExists(assets.path(test.blog.id, "_assets/doc"))).toBe(false);
    });

    it("does not touch another blog's staging directory", async function () {
      var test = this;
      var other = "blog_other" + test.blog.id.slice(5);

      await stage(other, "_assets/a.png", "other");
      await stage(test.blog.id, "_assets/a.png", "mine");
      await assets.commit(test.blog.id, "_assets");

      expect(await fs.pathExists(assets.path(other, "_assets/a.png"))).toBe(true);

      await fs.remove(assets.path(other));
    });
  });

  describe("writeFrom", function () {
    it("copies a file, leaving the source in place", async function () {
      var test = this;
      var src = join(test.tmp, "src.txt");

      await fs.outputFile(src, "copied");
      await assets.writeFrom(test.blog.id, "_assets/doc/src.txt", src);

      expect(await bodyOf(test.blog.id, "_assets/doc/src.txt")).toEqual("copied");
      expect(await fs.pathExists(src)).toBe(true);
      expect(await fs.pathExists(assets.path(test.blog.id, "_assets/doc"))).toBe(false);
    });

    it("replaces an existing object", async function () {
      var test = this;
      var src = join(test.tmp, "src.txt");

      await assets.write(test.blog.id, "_assets/a.txt", "old");
      await fs.outputFile(src, "new");
      await assets.writeFrom(test.blog.id, "_assets/a.txt", src);

      expect(await assets.read(test.blog.id, "_assets/a.txt")).toEqual(Buffer.from("new"));
    });

    it("moves a file, removing the source", async function () {
      var test = this;
      var src = join(test.tmp, "src.txt");

      await fs.outputFile(src, "moved");
      await assets.writeFrom(test.blog.id, "_avatars/src.txt", src, { move: true });

      expect(await bodyOf(test.blog.id, "_avatars/src.txt")).toEqual("moved");
      expect(await fs.pathExists(src)).toBe(false);
    });

    it("moves over an existing object", async function () {
      var test = this;
      var src = join(test.tmp, "src.txt");

      await assets.write(test.blog.id, "_avatars/a.txt", "old");
      await fs.outputFile(src, "new");
      await assets.writeFrom(test.blog.id, "_avatars/a.txt", src, { move: true });

      expect(await assets.read(test.blog.id, "_avatars/a.txt")).toEqual(Buffer.from("new"));
    });
  });

  describe("exists", function () {
    it("is true for objects and false otherwise", async function () {
      var test = this;

      await assets.write(test.blog.id, "_avatars/a.png", "a");

      expect(await assets.exists(test.blog.id, "_avatars/a.png")).toBe(true);
      expect(await assets.exists(test.blog.id, "/_avatars/a.png")).toBe(true);
      expect(await assets.exists(test.blog.id, "_avatars/b.png")).toBe(false);
      expect(await assets.exists(test.blog.id, "_nothing/b.png")).toBe(false);
    });
  });

  describe("list", function () {
    it("returns the names of a directory's immediate children", async function () {
      var test = this;

      await assets.write(test.blog.id, "_assets/doc/a.png", "a");
      await assets.write(test.blog.id, "_assets/doc/b.png", "b");
      await assets.write(test.blog.id, "_assets/doc/sub/c.png", "c");
      await putS3(test.blog.id, "_avatars/a.png", "s");

      expect(await assets.list(test.blog.id, "_assets/doc")).toEqual(["a.png", "b.png", "sub"]);
      expect(await assets.list(test.blog.id, "/_assets/doc/")).toEqual(["a.png", "b.png", "sub"]);
      expect(await assets.list(test.blog.id, "_assets")).toEqual(["doc"]);
      expect(await assets.list(test.blog.id)).toEqual(["_assets", "_avatars"]);
    });

    it("returns an empty array for a missing directory or a file", async function () {
      var test = this;

      await assets.write(test.blog.id, "_assets/a.png", "a");

      expect(await assets.list(test.blog.id, "_missing")).toEqual([]);
      expect(await assets.list(test.blog.id, "_assets/a.png")).toEqual([]);
    });

    it("does not list what is only staged", async function () {
      var test = this;

      await stage(test.blog.id, "_assets/staged.png", "a");

      expect(await assets.list(test.blog.id, "_assets")).toEqual([]);
    });
  });

  describe("walk", function () {
    async function collect(blogID) {
      var found = [];
      for await (var relPath of assets.walk(blogID)) found.push(relPath);
      return found.sort();
    }

    it("yields every object in the blog's scope without a leading slash", async function () {
      var test = this;
      var other = "blog_other" + test.blog.id.slice(5);

      await assets.write(test.blog.id, "_avatars/a.png", "a");
      await assets.write(test.blog.id, "_assets/doc/media/b.png", "b");
      await putS3(test.blog.id, "_thumbnails/x/small.jpg", "c");
      await putS3(other, "_avatars/other.png", "other");

      expect(await collect(test.blog.id)).toEqual([
        "_assets/doc/media/b.png",
        "_avatars/a.png",
        "_thumbnails/x/small.jpg",
      ]);
    });

    it("yields nothing when the blog has no assets", async function () {
      expect(await collect(this.blog.id)).toEqual([]);
    });
  });

  describe("createReadStream", function () {
    it("streams the object's content", async function () {
      var test = this;

      await assets.write(test.blog.id, "_assets/a.txt", "streamed");

      expect(await slurp(assets.createReadStream(test.blog.id, "/_assets/a.txt"))).toEqual("streamed");
    });

    it("errors with NotFoundError for a missing object", async function () {
      var error = await rejection(slurp(assets.createReadStream(this.blog.id, "_assets/missing.txt")));

      expect(error instanceof assets.NotFoundError).toBe(true);
      expect(error.code).toEqual("ENOENT");
    });
  });

  describe("ensureLocal", function () {
    it("downloads the object into a cache under the tmp directory", async function () {
      var test = this;

      await putS3(test.blog.id, "_assets/doc/s3.txt", "s3");

      var downloaded = await assets.ensureLocal(test.blog.id, "/_assets/doc/s3.txt");

      expect(downloaded).toEqual(join(config.tmp_directory, "storage-assets", test.blog.id, "_assets/doc/s3.txt"));
      expect(downloaded.indexOf(STAGING)).toEqual(-1);
      expect(await fs.readFile(downloaded, "utf-8")).toEqual("s3");
      expect(await fs.pathExists(assets.path(test.blog.id, "_assets/doc/s3.txt"))).toBe(false);
      expect(await assets.ensureLocal(test.blog.id, "_assets/doc/s3.txt")).toEqual(downloaded);
    });

    it("throws NotFoundError for a missing object", async function () {
      var error = await rejection(assets.ensureLocal(this.blog.id, "_assets/missing.txt"));

      expect(error instanceof assets.NotFoundError).toBe(true);
    });

    it("does not return a staged file", async function () {
      var test = this;

      await stage(test.blog.id, "_assets/staged.txt", "staged");

      expect(
        (await rejection(assets.ensureLocal(test.blog.id, "_assets/staged.txt"))) instanceof
          assets.NotFoundError
      ).toBe(true);
    });

    it("downloads a file again when the object was replaced", async function () {
      var test = this;

      await putS3(test.blog.id, "_assets/doc/s3.txt", "first");
      var downloaded = await assets.ensureLocal(test.blog.id, "_assets/doc/s3.txt");

      // S3's Last-Modified has a resolution of a second
      await new Promise(function (resolve) {
        setTimeout(resolve, 1100);
      });
      await putS3(test.blog.id, "_assets/doc/s3.txt", "second, and longer");

      expect(await fs.readFile(downloaded, "utf-8")).toEqual("first");
      expect(await assets.ensureLocal(test.blog.id, "_assets/doc/s3.txt")).toEqual(downloaded);
      expect(await fs.readFile(downloaded, "utf-8")).toEqual("second, and longer");
    });

    it("downloads a file once for callers which ask at the same time", async function () {
      var test = this;

      await putS3(test.blog.id, "_assets/doc/s3.txt", "shared");

      var paths = await Promise.all([
        assets.ensureLocal(test.blog.id, "_assets/doc/s3.txt"),
        assets.ensureLocal(test.blog.id, "_assets/doc/s3.txt"),
        assets.ensureLocal(test.blog.id, "_assets/doc/s3.txt"),
      ]);

      expect(paths[1]).toEqual(paths[0]);
      expect(paths[2]).toEqual(paths[0]);
      expect(await fs.readFile(paths[0], "utf-8")).toEqual("shared");
    });
  });

  describe("remove", function () {
    it("removes a file from the bucket", async function () {
      var test = this;

      await assets.write(test.blog.id, "_assets/a.txt", "a");
      await assets.write(test.blog.id, "_assets/b.txt", "b");
      await assets.remove(test.blog.id, "_assets/a.txt");

      expect(await keys(test.blog.id + "/")).toEqual([test.blog.id + "/_assets/b.txt"]);
    });

    it("removes everything below a directory, and nothing beside it", async function () {
      var test = this;

      await assets.write(test.blog.id, "_thumbnails/x/small.jpg", "a");
      await assets.write(test.blog.id, "_thumbnails/y/small.jpg", "a");
      await assets.write(test.blog.id, "_thumbnails2/x.jpg", "a");
      await assets.write(test.blog.id, "_avatars/a.png", "a");

      await assets.remove(test.blog.id, "_thumbnails");

      expect(await keys(test.blog.id + "/")).toEqual([
        test.blog.id + "/_avatars/a.png",
        test.blog.id + "/_thumbnails2/x.jpg",
      ]);
    });

    it("removes more objects than fit in one delete request", async function () {
      var test = this;
      var pool = require("storage/util").createPool(16);

      await fs.outputFile(join(test.tmp, "tiny.txt"), "x");

      for (var i = 0; i < 1105; i++) {
        await pool.add(s3.upload.bind(s3, test.blog.id, "_image_cache/" + i + ".txt", join(test.tmp, "tiny.txt")));
      }
      await pool.drain();

      expect((await keys(test.blog.id + "/_image_cache/")).length).toEqual(1105);

      await assets.remove(test.blog.id, "_image_cache");

      expect(await keys(test.blog.id + "/")).toEqual([]);
    }, 60000);

    it("also removes what a tool left in staging", async function () {
      var test = this;

      await assets.write(test.blog.id, "_assets/doc/a.txt", "a");
      await stage(test.blog.id, "_assets/doc/leftover.txt", "left");
      await assets.remove(test.blog.id, "_assets/doc");

      expect(await keys(test.blog.id + "/")).toEqual([]);
      expect(await fs.pathExists(assets.path(test.blog.id, "_assets/doc"))).toBe(false);
    });

    it("is not an error when the path is missing", async function () {
      await assets.remove(this.blog.id, "_thumbnails/missing.jpg");
      await assets.remove(this.blog.id, "_missing");
    });

    it("refuses to remove the whole scope", async function () {
      var test = this;

      await assets.write(test.blog.id, "_avatars/a.png", "a");

      for (var relPath of ["", "/", ".", "_avatars/.."]) {
        expect(await rejection(assets.remove(test.blog.id, relPath))).toBeTruthy();
      }

      expect(await keys(test.blog.id + "/")).toEqual([test.blog.id + "/_avatars/a.png"]);
    });
  });

  describe("removeAll", function () {
    it("removes a blog's objects but not other blogs'", async function () {
      var test = this;
      var other = "blog_other" + test.blog.id.slice(5);

      await assets.write(test.blog.id, "_avatars/a.png", "a");
      await assets.write(test.blog.id, "_assets/doc/b.png", "b");
      await putS3(other, "_avatars/a.png", "other");

      await assets.removeAll(test.blog.id);

      expect(await keys(test.blog.id + "/")).toEqual([]);
      expect(await keys(other + "/")).toEqual([other + "/_avatars/a.png"]);
    });

    it("also removes the blog's staging directory and download cache", async function () {
      var test = this;

      await putS3(test.blog.id, "_assets/cached.txt", "c");
      var cached = await assets.ensureLocal(test.blog.id, "_assets/cached.txt");
      await stage(test.blog.id, "_thumbnails/x/leftover.jpg", "left");

      await assets.removeAll(test.blog.id);

      expect(await fs.pathExists(assets.path(test.blog.id))).toBe(false);
      expect(await fs.pathExists(cached)).toBe(false);
    });

    it("is a no-op when the blog has nothing", async function () {
      var test = this;

      await assets.removeAll(test.blog.id);
      await assets.removeAll(test.blog.id);
    });
  });

  describe("when the bucket can't be reached", function () {
    beforeEach(function () {
      // nothing is listening on port 1
      config.storage.endpoint = "http://127.0.0.1:1";
      s3.reset();
    });

    // so the test blog can be cleaned up
    afterEach(function () {
      config.storage.endpoint = process.env.BLOT_STORAGE_ENDPOINT;
      s3.reset();
    });

    it("throws a failed write and leaves nothing staged", async function () {
      var test = this;

      expect(await rejection(assets.write(test.blog.id, "_assets/a.txt", "a"))).toBeTruthy();
      expect(await fs.pathExists(assets.path(test.blog.id, "_assets/a.txt"))).toBe(false);
      expect(await fs.pathExists(assets.path(test.blog.id, "_assets"))).toBe(true);
    }, 30000);

    it("throws a failed writeFrom and leaves nothing staged, keeping a copied source", async function () {
      var test = this;
      var src = join(test.tmp, "src.txt");

      await fs.outputFile(src, "x");

      expect(await rejection(assets.writeFrom(test.blog.id, "_assets/a.txt", src))).toBeTruthy();
      expect(await fs.pathExists(assets.path(test.blog.id, "_assets/a.txt"))).toBe(false);
      expect(await fs.pathExists(src)).toBe(true);
    }, 30000);

    it("throws a failed commit and deletes the staged files, but not another file staged beside them", async function () {
      var test = this;

      await stage(test.blog.id, "_assets/doc/media/a.txt", "a");
      await stage(test.blog.id, "_assets/doc/b.txt", "b");
      await stage(test.blog.id, "_assets/other/c.txt", "c");

      expect(await rejection(assets.commit(test.blog.id, "_assets/doc"))).toBeTruthy();
      expect(await fs.pathExists(assets.path(test.blog.id, "_assets/doc"))).toBe(false);
      expect(await fs.pathExists(assets.path(test.blog.id, "_assets/other/c.txt"))).toBe(true);
    }, 30000);

    it("throws a failed commit of a single file and deletes it", async function () {
      var test = this;

      await stage(test.blog.id, "_assets/a.txt", "a");
      await stage(test.blog.id, "_assets/b.txt", "b");

      expect(await rejection(assets.commit(test.blog.id, "_assets/a.txt"))).toBeTruthy();
      expect(await fs.pathExists(assets.path(test.blog.id, "_assets/a.txt"))).toBe(false);
      expect(await fs.pathExists(assets.path(test.blog.id, "_assets/b.txt"))).toBe(true);
    }, 30000);

    it("throws a failed delete, but still removes what is staged", async function () {
      var test = this;

      await stage(test.blog.id, "_assets/a.txt", "a");

      expect(await rejection(assets.remove(test.blog.id, "_assets/a.txt"))).toBeTruthy();
      expect(await fs.pathExists(assets.path(test.blog.id, "_assets/a.txt"))).toBe(false);
      expect(await rejection(assets.removeAll(test.blog.id))).toBeTruthy();
    }, 30000);

    it("throws a failed read, listing and existence check", async function () {
      var test = this;

      expect(await rejection(assets.read(test.blog.id, "_assets/a.txt"))).toBeTruthy();
      expect(await rejection(assets.list(test.blog.id, "_assets"))).toBeTruthy();
      expect(await rejection(assets.exists(test.blog.id, "_assets/a.txt"))).toBeTruthy();
    }, 30000);
  });
});
