describe("cdn serving a blog's assets", function () {
  global.test.blog();

  const Express = require("express");
  const http = require("http");
  const fetch = require("node-fetch");
  const assets = require("storage/assets");
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
