describe("cdn serving a blog's assets", function () {
  global.test.blog();

  const Express = require("express");
  const http = require("http");
  const fetch = require("node-fetch");
  const assets = require("storage/assets");
  const config = require("config");
  const fs = require("fs-extra");
  const { join } = require("path");
  let server, origin;

  beforeEach(function (done) {
    const app = Express();
    app.use(require("cdn"));
    server = app.listen(0, function () {
      origin = "http://127.0.0.1:" + server.address().port;
      done();
    });
  });

  afterEach(function (done) {
    server.close(done);
  });

  it("serves a file with a year of caching and CORS", async function () {
    await assets.write(this.blog.id, "_image_cache/a/photo.png", "png-bytes");

    const res = await fetch(origin + "/" + this.blog.id + "/_image_cache/a/photo.png");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("png-bytes");
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("etag")).toBeTruthy();
  });

  it("decodes the path", async function () {
    await assets.write(this.blog.id, "_template_assets/a b.png", "spaced");

    const res = await fetch(origin + "/" + this.blog.id + "/_template_assets/a%20b.png");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("spaced");
  });

  it("answers HEAD requests and rejects other methods", async function () {
    await assets.write(this.blog.id, "_avatars/a.png", "png-bytes");
    const url = origin + "/" + this.blog.id + "/_avatars/a.png";

    expect((await fetch(url, { method: "HEAD" })).status).toBe(200);

    const res = await fetch(url, { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
  });

  it("responds 404 for missing files, directories and other blogs' directories", async function () {
    await assets.write(this.blog.id, "_assets/doc/a.png", "a");

    for (const path of [
      "/" + this.blog.id + "/_assets/missing.png",
      "/" + this.blog.id + "/_assets/doc",
      "/" + this.blog.id + "/_assets/doc/",
      "/" + this.blog.id,
      "/not-a-blog/_assets/doc/a.png",
    ]) {
      expect((await fetch(origin + path)).status).toBe(404);
    }
  });

  it("responds 404 for a path outside the assets scope, even one which exists", async function () {
    await fs.outputFile(assets.path(this.blog.id, "_assets/a.txt"), "a");
    await fs.outputFile(
      join(config.blog_static_files_dir, this.blog.id, "folder/a.txt"),
      "not an asset"
    );

    for (const path of ["/folder/a.txt", "/folder", "/a.txt"]) {
      expect((await fetch(origin + "/" + this.blog.id + path)).status).toBe(404);
    }
  });

  describe("with a bucket", function () {
    const s3 = require("storage/s3");
    const { PutObjectCommand } = require("@aws-sdk/client-s3");

    require("./minio")();

    it("responds 404 for /blog_x/folder/a.txt although the bucket has that object", async function () {
      await s3.client().send(
        new PutObjectCommand({
          Bucket: config.storage.bucket,
          Key: this.blog.id + "/folder/a.txt",
          Body: Buffer.from("folder content"),
        })
      );
      await assets.write(this.blog.id, "_assets/a.txt", "asset");

      for (const order of ["disk", "s3"]) {
        config.assets.read = order;

        const res = await fetch(origin + "/" + this.blog.id + "/folder/a.txt");
        expect(res.status).toBe(404);
        expect(await res.text()).not.toContain("folder content");

        const asset = await fetch(origin + "/" + this.blog.id + "/_assets/a.txt");
        expect(asset.status).toBe(200);
        expect(await asset.text()).toBe("asset");
      }
    });
  });

  it("does not serve dotfiles", async function () {
    await assets.write(this.blog.id, "_assets/.hidden", "secret");

    const res = await fetch(origin + "/" + this.blog.id + "/_assets/.hidden");

    expect(res.status).toBe(404);
  });

  it("does not let a path climb out of the blog's directory", async function () {
    const other = "blog_" + "0".repeat(32);
    await assets.write(other, "_assets/secret.txt", "secret");

    try {
      const status = await new Promise(function (resolve, reject) {
        http
          .get(
            {
              host: "127.0.0.1",
              port: server.address().port,
              path: "/" + this.blog.id + "/../" + other + "/_assets/secret.txt",
            },
            function (res) {
              res.resume();
              resolve(res.statusCode);
            }
          )
          .on("error", reject);
      }.bind(this));

      expect(status).toBe(403);
    } finally {
      await assets.removeAll(other);
    }
  });
});
