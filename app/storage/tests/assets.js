describe("storage/assets", function () {
  global.test.blog();

  var assets = require("storage/assets");
  var config = require("config");
  var fs = require("fs-extra");
  var join = require("path").join;

  it("joins a path inside the blog's asset directory", function () {
    var test = this;
    var expected = join(
      config.blog_static_files_dir,
      test.blog.id,
      "_thumbnails",
      "foo.jpg"
    );

    expect(assets.path(test.blog.id, "_thumbnails", "foo.jpg")).toEqual(
      expected
    );
  });

  it("returns the blog's root directory when called with no segments", function () {
    var test = this;
    var expected = join(config.blog_static_files_dir, test.blog.id);

    expect(assets.path(test.blog.id)).toEqual(expected);
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

  it("rejects a blogID which is not a non-empty string", function () {
    expect(function () {
      assets.path("", "x");
    }).toThrow();

    expect(function () {
      assets.path(undefined, "x");
    }).toThrow();
  });

  it("removeAll removes the blog's entire asset directory", function (done) {
    var test = this;
    var root = assets.path(test.blog.id);
    var path = join(root, "_thumbnails", "foo.jpg");

    fs.outputFile(path, "hello", function (err) {
      if (err) return done.fail(err);

      assets.removeAll(test.blog.id).then(function () {
        fs.pathExists(root, function (err, exists) {
          if (err) return done.fail(err);
          expect(exists).toBe(false);
          done();
        });
      }, done.fail);
    });
  });

  it("removeAll is a no-op when the directory does not exist", function (done) {
    var test = this;

    assets.removeAll(test.blog.id).then(function () {
      assets.removeAll(test.blog.id).then(function () {
        done();
      }, done.fail);
    }, done.fail);
  });

  describe("relPath arguments", function () {
    it("accept a leading slash and reject paths which escape", async function () {
      var test = this;

      await assets.write(test.blog.id, "/_thumbnails/a.txt", "a");
      expect(
        await fs.readFile(assets.path(test.blog.id, "_thumbnails/a.txt"), "utf-8")
      ).toEqual("a");

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
    it("writes a string, creating parent directories", async function () {
      var test = this;

      await assets.write(test.blog.id, "_assets/doc/a.txt", "hello");

      expect(await fs.readFile(assets.path(test.blog.id, "_assets/doc/a.txt"), "utf-8")).toEqual("hello");
    });

    it("writes and reads a Buffer", async function () {
      var test = this;
      var data = Buffer.from([0, 1, 2, 255]);

      await assets.write(test.blog.id, "_avatars/a.bin", data);
      var read = await assets.read(test.blog.id, "_avatars/a.bin");

      expect(Buffer.isBuffer(read)).toBe(true);
      expect(read.equals(data)).toBe(true);
    });

    it("read throws NotFoundError when the file is missing", async function () {
      var test = this;
      var error;

      try {
        await assets.read(test.blog.id, "_avatars/missing.png");
      } catch (err) {
        error = err;
      }

      expect(error instanceof assets.NotFoundError).toBe(true);
      expect(error.code).toEqual("ENOENT");
    });

    it("read throws NotFoundError when a parent is a file", async function () {
      var test = this;
      var error;

      await assets.write(test.blog.id, "_avatars/a.txt", "a");

      try {
        await assets.read(test.blog.id, "_avatars/a.txt/b");
      } catch (err) {
        error = err;
      }

      expect(error instanceof assets.NotFoundError).toBe(true);
    });
  });

  describe("commit", function () {
    it("resolves for a file written locally", async function () {
      var test = this;

      await fs.outputFile(assets.path(test.blog.id, "_thumbnails/x/a.jpg"), "a");
      await assets.commit(test.blog.id, "_thumbnails/x/a.jpg");
      expect(await assets.exists(test.blog.id, "_thumbnails/x/a.jpg")).toBe(true);
    });

    it("resolves for a directory written locally", async function () {
      var test = this;

      await fs.outputFile(assets.path(test.blog.id, "_assets/doc/media/a.png"), "a");
      await assets.commit(test.blog.id, "_assets/doc");
      expect(await assets.exists(test.blog.id, "_assets/doc/media/a.png")).toBe(true);
    });

    it("resolves when nothing was written", async function () {
      await assets.commit(this.blog.id, "_assets/nothing");
    });
  });

  describe("writeFrom", function () {
    global.test.tmp();

    it("copies a file, leaving the source in place", async function () {
      var test = this;
      var src = join(test.tmp, "src.txt");

      await fs.outputFile(src, "copied");
      await assets.writeFrom(test.blog.id, "_assets/doc/src.txt", src);

      expect(await fs.readFile(assets.path(test.blog.id, "_assets/doc/src.txt"), "utf-8")).toEqual("copied");
      expect(await fs.pathExists(src)).toBe(true);
    });

    it("copy replaces an existing file by default", async function () {
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

      expect(await fs.readFile(assets.path(test.blog.id, "_avatars/src.txt"), "utf-8")).toEqual("moved");
      expect(await fs.pathExists(src)).toBe(false);
    });

    it("move refuses to replace an existing file unless overwrite is set", async function () {
      var test = this;
      var src = join(test.tmp, "src.txt");
      var failed = false;

      await assets.write(test.blog.id, "_avatars/a.txt", "old");
      await fs.outputFile(src, "new");

      try {
        await assets.writeFrom(test.blog.id, "_avatars/a.txt", src, { move: true });
      } catch (err) {
        failed = true;
      }

      expect(failed).toBe(true);
      expect(await assets.read(test.blog.id, "_avatars/a.txt")).toEqual(Buffer.from("old"));

      await assets.writeFrom(test.blog.id, "_avatars/a.txt", src, { move: true, overwrite: true });
      expect(await assets.read(test.blog.id, "_avatars/a.txt")).toEqual(Buffer.from("new"));
    });
  });

  describe("exists", function () {
    it("is true for files and directories and false otherwise", async function () {
      var test = this;

      await assets.write(test.blog.id, "_avatars/a.png", "a");

      expect(await assets.exists(test.blog.id, "_avatars/a.png")).toBe(true);
      expect(await assets.exists(test.blog.id, "/_avatars")).toBe(true);
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

      expect((await assets.list(test.blog.id, "_assets/doc")).sort()).toEqual(["a.png", "b.png", "sub"]);
      expect(await assets.list(test.blog.id, "_assets")).toEqual(["doc"]);
    });

    it("returns an empty array for a missing directory or a file", async function () {
      var test = this;

      await assets.write(test.blog.id, "_assets/a.png", "a");

      expect(await assets.list(test.blog.id, "_missing")).toEqual([]);
      expect(await assets.list(test.blog.id, "_assets/a.png")).toEqual([]);
    });
  });

  describe("walk", function () {
    async function collect(blogID) {
      var found = [];
      for await (var relPath of assets.walk(blogID)) found.push(relPath);
      return found.sort();
    }

    it("yields every file in the blog's scope without a leading slash", async function () {
      var test = this;

      await assets.write(test.blog.id, "_avatars/a.png", "a");
      await assets.write(test.blog.id, "_assets/doc/media/b.png", "b");
      await assets.write(test.blog.id, "_thumbnails/x/small.jpg", "c");

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
    it("streams the file's content", async function () {
      var test = this;

      await assets.write(test.blog.id, "_assets/a.txt", "streamed");

      var chunks = [];
      for await (var chunk of assets.createReadStream(test.blog.id, "/_assets/a.txt")) {
        chunks.push(chunk);
      }

      expect(Buffer.concat(chunks).toString()).toEqual("streamed");
    });
  });

  describe("ensureLocal", function () {
    it("returns the absolute local path of an existing file", async function () {
      var test = this;

      await assets.write(test.blog.id, "_assets/a.txt", "a");

      expect(await assets.ensureLocal(test.blog.id, "/_assets/a.txt")).toEqual(
        assets.path(test.blog.id, "_assets/a.txt")
      );
    });

    it("throws NotFoundError for a missing file", async function () {
      var test = this;
      var error;

      try {
        await assets.ensureLocal(test.blog.id, "_assets/missing.txt");
      } catch (err) {
        error = err;
      }

      expect(error instanceof assets.NotFoundError).toBe(true);
    });
  });

  describe("remove", function () {
    it("removes a file", async function () {
      var test = this;

      await assets.write(test.blog.id, "_avatars/a.png", "a");
      await assets.write(test.blog.id, "_avatars/b.png", "b");
      await assets.remove(test.blog.id, "_avatars/a.png");

      expect(await assets.exists(test.blog.id, "_avatars/a.png")).toBe(false);
      expect(await assets.exists(test.blog.id, "_avatars/b.png")).toBe(true);
    });

    it("removes a directory and everything in it", async function () {
      var test = this;

      await assets.write(test.blog.id, "_thumbnails/x/small.jpg", "a");
      await assets.write(test.blog.id, "_avatars/b.png", "b");
      await assets.remove(test.blog.id, "_thumbnails");

      expect(await assets.exists(test.blog.id, "_thumbnails")).toBe(false);
      expect(await assets.exists(test.blog.id, "_avatars/b.png")).toBe(true);
    });

    it("is not an error when the path is missing", async function () {
      await assets.remove(this.blog.id, "_thumbnails/missing.jpg");
      await assets.remove(this.blog.id, "_missing");
    });

    it("refuses to remove the whole scope", async function () {
      var test = this;

      await assets.write(test.blog.id, "_avatars/a.png", "a");

      for (var relPath of ["", "/", ".", "_avatars/.."]) {
        var failed = false;
        try {
          await assets.remove(test.blog.id, relPath);
        } catch (err) {
          failed = true;
        }
        expect(failed).toBe(true);
      }

      expect(await assets.exists(test.blog.id, "_avatars/a.png")).toBe(true);
    });
  });

  describe("serve", function () {
    var express = require("express");
    var fetch = require("node-fetch");
    var server, origin;

    beforeEach(function (done) {
      var test = this;
      var app = express();

      app.get("/serve/*", function (req, res, next) {
        assets
          .serve(req, res, test.blog.id, req.params[0], {
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
        origin = "http://127.0.0.1:" + server.address().port;
        done();
      });
    });

    afterEach(function (done) {
      server.close(done);
    });

    it("sends the file with caching headers and a content type", async function () {
      await assets.write(this.blog.id, "_avatars/a.png", "png-bytes");

      var res = await fetch(origin + "/serve/_avatars/a.png");

      expect(res.status).toEqual(200);
      expect(await res.text()).toEqual("png-bytes");
      expect(res.headers.get("content-type")).toEqual("image/png");
      expect(res.headers.get("cache-control")).toEqual("public, max-age=31536000");
      expect(res.headers.get("etag")).toBeTruthy();
      expect(res.headers.get("last-modified")).toBeTruthy();
      expect(res.headers.get("accept-ranges")).toEqual("bytes");
    });

    it("adds immutable and custom headers when asked", async function () {
      await assets.write(this.blog.id, "_avatars/a.png", "png-bytes");

      var res = await fetch(origin + "/serve/_avatars/a.png?immutable=1&type=image/x-test");

      expect(res.headers.get("cache-control")).toEqual("public, max-age=31536000, immutable");
      expect(res.headers.get("content-type")).toEqual("image/x-test");
    });

    it("supports range requests and conditional requests", async function () {
      await assets.write(this.blog.id, "_assets/a.txt", "0123456789");

      var ranged = await fetch(origin + "/serve/_assets/a.txt", {
        headers: { Range: "bytes=2-4" },
      });

      expect(ranged.status).toEqual(206);
      expect(await ranged.text()).toEqual("234");

      var first = await fetch(origin + "/serve/_assets/a.txt");
      var cached = await fetch(origin + "/serve/_assets/a.txt", {
        headers: { "If-None-Match": first.headers.get("etag") },
      });

      expect(cached.status).toEqual(304);
    });

    it("rejects with NotFoundError for a missing file or a directory", async function () {
      await assets.write(this.blog.id, "_assets/doc/a.txt", "a");

      expect((await fetch(origin + "/serve/_assets/missing.txt")).status).toEqual(404);
      expect((await fetch(origin + "/serve/_assets/doc")).status).toEqual(404);
    });

    it("serves dotfiles unless told to ignore them", async function () {
      await assets.write(this.blog.id, "_assets/.hidden", "secret");

      expect((await fetch(origin + "/serve/_assets/.hidden")).status).toEqual(200);
      expect((await fetch(origin + "/serve/_assets/.hidden?dotfiles=ignore")).status).toEqual(404);
    });

    it("refuses a relPath which escapes the blog's directory", async function () {
      var test = this;
      var failed = false;

      try {
        await assets.serve({}, {}, test.blog.id, "/../x", {});
      } catch (err) {
        failed = /escapes/.test(err.message);
      }

      expect(failed).toBe(true);
    });
  });
});
