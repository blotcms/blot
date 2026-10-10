describe("storage/assets with an S3 bucket", function () {
  global.test.blog();
  global.test.tmp();

  var assets = require("storage/assets");
  var s3 = require("storage/s3");
  var config = require("config");
  var fs = require("fs-extra");
  var join = require("path").join;
  var express = require("express");
  var fetch = require("node-fetch");
  var { PutObjectCommand } = require("@aws-sdk/client-s3");
  var useBucket = require("./minio");

  useBucket();

  // Puts an object straight into the bucket, bypassing the local disk
  async function putS3(blogID, relPath, data) {
    await s3.client().send(
      new PutObjectCommand({
        Bucket: config.storage.bucket,
        Key: blogID + "/" + relPath,
        Body: Buffer.from(data),
      })
    );
  }

  // Writes a file to the local disk only, without committing it
  async function putDisk(blogID, relPath, data) {
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

  describe("commit", function () {
    it("uploads a file with its content type and a year of caching", async function () {
      var test = this;

      await putDisk(test.blog.id, "_thumbnails/x/small.png", "png-bytes");
      await assets.commit(test.blog.id, "_thumbnails/x/small.png");

      var object = await s3.head(test.blog.id + "/_thumbnails/x/small.png");

      expect(object.size).toEqual(9);
      expect(object.contentType).toEqual("image/png");
      expect(object.cacheControl).toEqual("public, max-age=31536000, immutable");
      expect(await bodyOf(test.blog.id, "_thumbnails/x/small.png")).toEqual("png-bytes");
    });

    it("types unknown extensions as octet-stream and mp4 as video", async function () {
      var test = this;

      await putDisk(test.blog.id, "_assets/a.unknownext", "a");
      await putDisk(test.blog.id, "_assets/b.mp4", "b");
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
        await putDisk(test.blog.id, relPath, "image " + i);
        expected.push(test.blog.id + "/" + relPath);
      }

      await assets.commit(test.blog.id, "_assets/doc");

      expect(await keys(test.blog.id + "/")).toEqual(expected.sort());
      expect(await bodyOf(test.blog.id, "_assets/doc/media/odd/image7.jpg")).toEqual("image 7");
    });

    it("waits for uploads in flight before failing a directory when S3 is read first", async function () {
      var test = this;
      var upload = s3.upload;
      var inFlight = 0;
      var started = 0;

      for (var i = 0; i < 24; i++) {
        await putDisk(test.blog.id, "_assets/doc/file" + i + ".txt", "file " + i);
      }

      config.assets.read = "s3";

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

      var err;

      try {
        await assets.commit(test.blog.id, "_assets/doc");
      } catch (e) {
        err = e;
      } finally {
        config.assets.read = "disk";
      }

      var inFlightWhenRejected = inFlight;

      expect(err && err.message).toEqual("upload failed");
      expect(inFlightWhenRejected).toEqual(0);
      // it stopped starting uploads once one had failed
      expect(started).toBeLessThan(24);
      expect(started).toBeGreaterThan(1);
    });

    it("does nothing when there's nothing at the path", async function () {
      await assets.commit(this.blog.id, "_assets/nothing");

      expect(await keys(this.blog.id + "/")).toEqual([]);
    });

    it("writes to disk and to the bucket", async function () {
      var test = this;
      var src = join(test.tmp, "src.txt");

      await assets.write(test.blog.id, "_assets/written.txt", "written");
      await fs.outputFile(src, "copied");
      await assets.writeFrom(test.blog.id, "_assets/copied.txt", src);

      expect(await fs.readFile(assets.path(test.blog.id, "_assets/written.txt"), "utf-8")).toEqual("written");
      expect(await bodyOf(test.blog.id, "_assets/written.txt")).toEqual("written");
      expect(await fs.readFile(assets.path(test.blog.id, "_assets/copied.txt"), "utf-8")).toEqual("copied");
      expect(await bodyOf(test.blog.id, "_assets/copied.txt")).toEqual("copied");
    });

    it("leaves the bucket alone when no bucket is configured", async function () {
      var test = this;
      var bucket = config.storage.bucket;

      config.storage.bucket = "";
      await assets.write(test.blog.id, "_assets/local-only.txt", "x");
      config.storage.bucket = bucket;

      expect(await fs.pathExists(assets.path(test.blog.id, "_assets/local-only.txt"))).toBe(true);
      expect(await keys(test.blog.id + "/")).toEqual([]);
    });
  });

  // Each of these runs once with disk read first and once with S3 first
  ["disk", "s3"].forEach(function (order) {
    describe("reading, " + order + " first", function () {
      beforeEach(function () {
        config.assets.read = order;
      });

      it("reads a file which is only on disk, only in S3, or both", async function () {
        var test = this;

        await putDisk(test.blog.id, "_assets/disk.txt", "disk");
        await putS3(test.blog.id, "_assets/s3.txt", "s3");
        await putDisk(test.blog.id, "_assets/both.txt", "from disk");
        await putS3(test.blog.id, "_assets/both.txt", "from s3");

        expect((await assets.read(test.blog.id, "_assets/disk.txt")).toString()).toEqual("disk");
        expect((await assets.read(test.blog.id, "_assets/s3.txt")).toString()).toEqual("s3");
        expect((await assets.read(test.blog.id, "_assets/both.txt")).toString()).toEqual(
          order === "disk" ? "from disk" : "from s3"
        );
      });

      it("reports a missing file as not found", async function () {
        var test = this;
        var error = await rejection(assets.read(test.blog.id, "_assets/missing.txt"));

        expect(error instanceof assets.NotFoundError).toBe(true);
        expect(error.code).toEqual("ENOENT");
        expect(await assets.exists(test.blog.id, "_assets/missing.txt")).toBe(false);
        expect(
          (await rejection(assets.ensureLocal(test.blog.id, "_assets/missing.txt"))) instanceof
            assets.NotFoundError
        ).toBe(true);
      });

      it("says whether a file exists", async function () {
        var test = this;

        await putDisk(test.blog.id, "_assets/disk.txt", "disk");
        await putS3(test.blog.id, "_assets/s3.txt", "s3");

        expect(await assets.exists(test.blog.id, "_assets/disk.txt")).toBe(true);
        expect(await assets.exists(test.blog.id, "_assets/s3.txt")).toBe(true);
      });

      it("gives a local path for a file wherever it is", async function () {
        var test = this;

        await putDisk(test.blog.id, "_assets/disk.txt", "disk");
        await putS3(test.blog.id, "_assets/doc/s3.txt", "s3");

        expect(await assets.ensureLocal(test.blog.id, "_assets/disk.txt")).toEqual(
          assets.path(test.blog.id, "_assets/disk.txt")
        );

        var downloaded = await assets.ensureLocal(test.blog.id, "_assets/doc/s3.txt");

        expect(downloaded.indexOf(join(config.tmp_directory, "storage-assets", test.blog.id))).toEqual(0);
        expect(downloaded.indexOf(config.blog_static_files_dir)).toEqual(-1);
        expect(await fs.readFile(downloaded, "utf-8")).toEqual("s3");
        expect(await fs.pathExists(assets.path(test.blog.id, "_assets/doc/s3.txt"))).toBe(false);
        expect(await assets.ensureLocal(test.blog.id, "_assets/doc/s3.txt")).toEqual(downloaded);
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

      it("streams a file wherever it is", async function () {
        var test = this;

        async function slurp(stream) {
          var chunks = [];
          for await (var chunk of stream) chunks.push(chunk);
          return Buffer.concat(chunks).toString();
        }

        await putDisk(test.blog.id, "_assets/disk.txt", "disk");
        await putS3(test.blog.id, "_assets/s3.txt", "s3");

        expect(await slurp(assets.createReadStream(test.blog.id, "_assets/disk.txt"))).toEqual("disk");
        expect(await slurp(assets.createReadStream(test.blog.id, "_assets/s3.txt"))).toEqual("s3");

        var error = await rejection(slurp(assets.createReadStream(test.blog.id, "_assets/missing.txt")));

        expect(error.code).toEqual("ENOENT");
      });

      it("lists the children found on disk and in S3", async function () {
        var test = this;

        await putDisk(test.blog.id, "_assets/disk.txt", "d");
        await putDisk(test.blog.id, "_assets/both.txt", "d");
        await putS3(test.blog.id, "_assets/both.txt", "s");
        await putS3(test.blog.id, "_assets/s3.txt", "s");
        await putS3(test.blog.id, "_assets/doc/deep/a.txt", "s");
        await putS3(test.blog.id, "_avatars/a.png", "s");

        expect(await assets.list(test.blog.id, "_assets")).toEqual(["both.txt", "disk.txt", "doc", "s3.txt"]);
        expect(await assets.list(test.blog.id, "/_assets/doc/")).toEqual(["deep"]);
        expect(await assets.list(test.blog.id)).toEqual(["_assets", "_avatars"]);
        expect(await assets.list(test.blog.id, "_missing")).toEqual([]);
      });

      it("walks the files found on disk and in S3 once each", async function () {
        var test = this;
        var found = [];

        await putDisk(test.blog.id, "_assets/disk.txt", "d");
        await putDisk(test.blog.id, "_assets/both.txt", "d");
        await putS3(test.blog.id, "_assets/both.txt", "s");
        await putS3(test.blog.id, "_assets/doc/s3.txt", "s");

        for await (var relPath of assets.walk(test.blog.id)) found.push(relPath);

        expect(found.sort()).toEqual(["_assets/both.txt", "_assets/disk.txt", "_assets/doc/s3.txt"]);
      });
    });

    describe("serving, " + order + " first", function () {
      var server, origin;

      beforeEach(function (done) {
        var test = this;
        var app = express();

        config.assets.read = order;

        app.use("/serve", function (req, res, next) {
          assets
            .serve(req, res, test.blog.id, req.path, {
              maxAge: "1y",
              immutable: req.query.immutable === "1",
              headers: req.query.type ? { "Content-Type": req.query.type } : undefined,
              dotfiles: req.query.dotfiles,
            })
            .catch(function (err) {
              if (err instanceof assets.NotFoundError) return res.sendStatus(404);
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

      it("serves an object with its headers", async function () {
        await putS3(this.blog.id, "_avatars/a.png", "png-bytes");

        var res = await fetch(origin + "/_avatars/a.png?immutable=1");

        expect(res.status).toEqual(200);
        expect(await res.text()).toEqual("png-bytes");
        expect(res.headers.get("content-length")).toEqual("9");
        expect(res.headers.get("cache-control")).toEqual("public, max-age=31536000, immutable");
        expect(res.headers.get("etag")).toBeTruthy();
        expect(res.headers.get("last-modified")).toBeTruthy();
        expect(res.headers.get("accept-ranges")).toEqual("bytes");
      });

      it("only adds immutable when asked", async function () {
        await putS3(this.blog.id, "_avatars/a.png", "png-bytes");

        var res = await fetch(origin + "/_avatars/a.png");

        expect(res.headers.get("cache-control")).toEqual("public, max-age=31536000");
      });

      it("uses the content type the caller gives, else the object's", async function () {
        await putDisk(this.blog.id, "_avatars/b.png", "png-bytes");
        await assets.commit(this.blog.id, "_avatars/b.png");

        var res = await fetch(origin + "/_avatars/b.png?type=image/x-test");
        expect(res.headers.get("content-type")).toEqual("image/x-test");

        // a committed file has the type its name implies
        res = await fetch(origin + "/_avatars/b.png");
        expect(res.headers.get("content-type")).toEqual("image/png");
      });

      it("serves a range", async function () {
        await putS3(this.blog.id, "_assets/a.txt", "0123456789");

        var res = await fetch(origin + "/_assets/a.txt", { headers: { Range: "bytes=2-4" } });

        expect(res.status).toEqual(206);
        expect(await res.text()).toEqual("234");
        expect(res.headers.get("content-range")).toEqual("bytes 2-4/10");
        expect(res.headers.get("content-length")).toEqual("3");
      });

      it("sends the whole object for a multi-range request, which S3 can't serve", async function () {
        await putS3(this.blog.id, "_assets/a.txt", "0123456789");

        var res = await fetch(origin + "/_assets/a.txt", { headers: { Range: "bytes=0-1,4-5" } });

        expect(res.status).toEqual(200);
        expect(await res.text()).toEqual("0123456789");
      });

      it("rejects a range which can't be satisfied", async function () {
        await putS3(this.blog.id, "_assets/a.txt", "0123456789");

        var res = await fetch(origin + "/_assets/a.txt", { headers: { Range: "bytes=50-60" } });

        expect(res.status).toEqual(416);
        expect(res.headers.get("content-range")).toEqual("bytes */10");
      });

      it("answers a conditional request with 304", async function () {
        await putS3(this.blog.id, "_assets/a.txt", "0123456789");

        var first = await fetch(origin + "/_assets/a.txt");
        var etag = first.headers.get("etag");
        var modified = first.headers.get("last-modified");
        var byEtag = await fetch(origin + "/_assets/a.txt", { headers: { "If-None-Match": etag } });
        var bySince = await fetch(origin + "/_assets/a.txt", { headers: { "If-Modified-Since": modified } });
        var changed = await fetch(origin + "/_assets/a.txt", { headers: { "If-None-Match": '"other"' } });

        expect(byEtag.status).toEqual(304);
        expect(byEtag.headers.get("etag")).toEqual(etag);
        expect(await byEtag.text()).toEqual("");
        expect(bySince.status).toEqual(304);
        expect(changed.status).toEqual(200);
      });

      it("answers HEAD with headers and no body", async function () {
        await putS3(this.blog.id, "_assets/a.txt", "0123456789");

        var res = await fetch(origin + "/_assets/a.txt", { method: "HEAD" });

        expect(res.status).toEqual(200);
        expect(res.headers.get("content-length")).toEqual("10");
        expect(res.headers.get("etag")).toBeTruthy();
        expect(await res.text()).toEqual("");
      });

      it("responds 404 for what isn't there", async function () {
        await putS3(this.blog.id, "_assets/doc/a.txt", "a");

        expect((await fetch(origin + "/_assets/missing.txt")).status).toEqual(404);
        expect((await fetch(origin + "/_assets/missing.txt", { method: "HEAD" })).status).toEqual(404);
        expect((await fetch(origin + "/_assets/doc")).status).toEqual(404);
      });

      it("ignores dotfiles when asked", async function () {
        await putS3(this.blog.id, "_assets/.hidden", "secret");

        expect((await fetch(origin + "/_assets/.hidden")).status).toEqual(200);
        expect((await fetch(origin + "/_assets/.hidden?dotfiles=ignore")).status).toEqual(404);
      });

      it("serves a file which is only on disk", async function () {
        await putDisk(this.blog.id, "_assets/disk.txt", "on disk");

        var res = await fetch(origin + "/_assets/disk.txt");

        expect(res.status).toEqual(200);
        expect(await res.text()).toEqual("on disk");
      });

      it("serves the first source when a file is in both", async function () {
        await putDisk(this.blog.id, "_assets/both.txt", "from disk");
        await putS3(this.blog.id, "_assets/both.txt", "from s3");

        expect(await (await fetch(origin + "/_assets/both.txt")).text()).toEqual(
          order === "disk" ? "from disk" : "from s3"
        );
      });
    });
  });

  describe("remove", function () {
    it("removes a file from disk and the bucket", async function () {
      var test = this;

      await assets.write(test.blog.id, "_assets/a.txt", "a");
      await assets.write(test.blog.id, "_assets/b.txt", "b");
      await assets.remove(test.blog.id, "_assets/a.txt");

      expect(await keys(test.blog.id + "/")).toEqual([test.blog.id + "/_assets/b.txt"]);
      expect(await fs.pathExists(assets.path(test.blog.id, "_assets/a.txt"))).toBe(false);
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

    it("is not an error when the path is missing", async function () {
      await assets.remove(this.blog.id, "_thumbnails/missing.jpg");
      await assets.remove(this.blog.id, "_missing");
    });

    it("still refuses to remove the whole scope", async function () {
      var test = this;

      await assets.write(test.blog.id, "_avatars/a.png", "a");

      expect(await rejection(assets.remove(test.blog.id, ""))).toBeTruthy();
      expect(await rejection(assets.remove(test.blog.id, "_avatars/.."))).toBeTruthy();
      expect(await keys(test.blog.id + "/")).toEqual([test.blog.id + "/_avatars/a.png"]);
    });

    it("removeAll removes a blog's files everywhere but other blogs'", async function () {
      var test = this;
      var other = "blog_other" + test.blog.id.slice(5);

      await assets.write(test.blog.id, "_avatars/a.png", "a");
      await assets.write(test.blog.id, "_assets/doc/b.png", "b");
      await putS3(test.blog.id, "_assets/only-s3.png", "c");
      await putS3(other, "_avatars/a.png", "other");

      await assets.removeAll(test.blog.id);

      expect(await keys(test.blog.id + "/")).toEqual([]);
      expect(await keys(other + "/")).toEqual([other + "/_avatars/a.png"]);
      expect(await fs.pathExists(assets.path(test.blog.id))).toBe(false);
    });

    it("removeAll clears the bucket for a blog with nothing on disk", async function () {
      var test = this;

      await putS3(test.blog.id, "_assets/only-s3.png", "c");
      await assets.removeAll(test.blog.id);

      expect(await keys(test.blog.id + "/")).toEqual([]);
    });
  });

  describe("the assets scope in a bucket shared with other content", function () {
    // What the blog's folder content (folder/...) or a top-level object would
    // look like under the same {blogID}/ prefix
    async function putOthers(blogID) {
      await putS3(blogID, "folder/x", "folder content");
      await putS3(blogID, "folder/_sneaky/y", "looks like an asset dir");
      await putS3(blogID, "top.txt", "top level object");
    }

    function others(blogID) {
      return [
        blogID + "/folder/_sneaky/y",
        blogID + "/folder/x",
        blogID + "/top.txt",
      ];
    }

    it("rejects paths outside the scope without touching the bucket", async function () {
      var test = this;
      var id = test.blog.id;

      await putOthers(id);

      for (var order of ["disk", "s3"]) {
        config.assets.read = order;

        expect(await assets.exists(id, "folder/x")).toBe(false);
        expect((await rejection(assets.read(id, "folder/x"))) instanceof assets.NotFoundError).toBe(true);
        expect((await rejection(assets.ensureLocal(id, "folder/x"))) instanceof assets.NotFoundError).toBe(true);

        for (var call of [
          function () { return assets.remove(id, "folder"); },
          function () { return assets.write(id, "folder/z", "z"); },
        ]) {
          var err = await rejection(call());
          expect(err && err.message).toMatch(/not in the assets scope/);
        }
      }

      expect(await keys(id + "/")).toEqual(others(id));
    });

    it("serve answers NotFoundError for a path outside the scope, even if the bucket has the object", async function () {
      var test = this;
      var id = test.blog.id;

      await putOthers(id);

      for (var order of ["disk", "s3"]) {
        config.assets.read = order;

        var err = await rejection(
          assets.serve({ headers: {}, method: "GET" }, {}, id, "folder/x", {})
        );

        expect(err instanceof assets.NotFoundError).toBe(true);
      }
    });

    it("walk and list of the blog's root ignore other keys", async function () {
      var test = this;
      var id = test.blog.id;

      await assets.write(id, "_avatars/a.png", "a");
      await putS3(id, "_assets/only-s3.png", "c");
      await putOthers(id);

      var found = [];
      for await (var relPath of assets.walk(id)) found.push(relPath);

      expect(found.sort()).toEqual(["_assets/only-s3.png", "_avatars/a.png"]);
      expect(await assets.list(id)).toEqual(["_assets", "_avatars"]);
      expect(await assets.list(id, "")).toEqual(["_assets", "_avatars"]);
    });

    it("removeAll deletes the underscore prefixes and leaves everything else", async function () {
      var test = this;
      var id = test.blog.id;

      await assets.write(id, "_avatars/a.png", "a");
      await assets.write(id, "_assets/doc/b.png", "b");
      await putS3(id, "_image_cache/only-s3.png", "c");
      await putOthers(id);

      await assets.removeAll(id);

      expect(await keys(id + "/")).toEqual(others(id));
      expect(await fs.pathExists(assets.path(id))).toBe(false);
    });
  });

  describe("when the bucket can't be reached", function () {
    beforeEach(function () {
      // nothing is listening on port 1
      config.storage.endpoint = "http://127.0.0.1:1";
      s3.reset();
      spyOn(console, "log");
    });

    // so the test blog can be cleaned up
    afterEach(function () {
      config.storage.endpoint = process.env.BLOT_TEST_S3_ENDPOINT;
      config.assets.read = "disk";
      s3.reset();
    });

    function logged() {
      return console.log.calls
        .allArgs()
        .map(function (args) {
          return args.join(" ");
        })
        .join("\n");
    }

    it("logs a failed upload and carries on while reading from disk", async function () {
      var test = this;

      await assets.write(test.blog.id, "_assets/a.txt", "a");
      await putDisk(test.blog.id, "_assets/doc/b.txt", "b");
      await assets.commit(test.blog.id, "_assets/doc");

      expect(await fs.readFile(assets.path(test.blog.id, "_assets/a.txt"), "utf-8")).toEqual("a");
      expect(logged()).toContain("[storage/assets] s3 upload failed");
      expect(logged()).toContain("blog=" + test.blog.id);
      expect(logged()).toContain("path=_assets/a.txt");
      expect(logged()).toContain("path=_assets/doc/b.txt");
    }, 30000);

    it("throws a failed upload when reading from S3", async function () {
      var test = this;

      config.assets.read = "s3";

      expect(await rejection(assets.write(test.blog.id, "_assets/a.txt", "a"))).toBeTruthy();
      await putDisk(test.blog.id, "_assets/doc/b.txt", "b");
      expect(await rejection(assets.commit(test.blog.id, "_assets/doc"))).toBeTruthy();
    }, 30000);

    it("throws a failed delete even while reading from disk, keeping the local file", async function () {
      var test = this;

      await putDisk(test.blog.id, "_assets/a.txt", "a");

      expect(await rejection(assets.remove(test.blog.id, "_assets/a.txt"))).toBeTruthy();
      expect(await fs.pathExists(assets.path(test.blog.id, "_assets/a.txt"))).toBe(true);
    }, 30000);

    it("throws a failed removeAll even while reading from disk, after removing the local files", async function () {
      var test = this;

      await putDisk(test.blog.id, "_assets/a.txt", "a");

      expect(await rejection(assets.removeAll(test.blog.id))).toBeTruthy();
      expect(await fs.pathExists(assets.path(test.blog.id))).toBe(false);
    }, 30000);

    it("throws a failed delete when reading from S3", async function () {
      var test = this;

      config.assets.read = "s3";
      await putDisk(test.blog.id, "_assets/a.txt", "a");

      expect(await rejection(assets.remove(test.blog.id, "_assets/a.txt"))).toBeTruthy();
      expect(await rejection(assets.removeAll(test.blog.id))).toBeTruthy();
    }, 30000);
  });
});
