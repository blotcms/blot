describe("storage/assets serve", function () {
  global.test.blog();

  var assets = require("storage/assets");
  var s3 = require("storage/s3");
  var config = require("config");
  var express = require("express");
  var fetch = require("node-fetch");
  var { PutObjectCommand } = require("@aws-sdk/client-s3");
  var useBucket = require("./minio");

  useBucket();

  // Puts an object straight into the bucket
  async function putS3(blogID, relPath, data) {
    await s3.client().send(
      new PutObjectCommand({
        Bucket: config.storage.bucket,
        Key: blogID + "/" + relPath,
        Body: Buffer.from(data),
      })
    );
  }

  describe("over HTTP", function () {
    var server, origin;

    beforeEach(function (done) {
      var test = this;
      var app = express();

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
      await assets.write(this.blog.id, "_avatars/b.png", "png-bytes");

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
