describe("sandbox fetch-image job", function () {
  const http = require("http");
  const zlib = require("zlib");
  const sharp = require("sharp");
  const config = require("config");
  const sandbox = require("../");
  const { MAX_REDIRECTS, MAX_DECODED_BYTES, MAX_DIMENSION } = require("../jobs/fetch-image");

  const MiB = 1024 * 1024;
  const empty = Buffer.alloc(0);

  let socket, server, origin, routes, requests;

  const fetchImage = (args) => sandbox.run("fetch-image", args, empty);

  beforeAll(async function () {
    server = http.createServer((req, res) => {
      requests.push(req);
      const route = routes[req.url];
      if (!route) {
        res.statusCode = 404;
        return res.end("not found");
      }
      route(req, res);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(function (done) {
    server.close(done);
  });

  beforeEach(function () {
    // no broker: the job runs in-process
    socket = config.sandbox.socket;
    config.sandbox.socket = "";
    routes = {};
    requests = [];
  });

  afterEach(function () {
    config.sandbox.socket = socket;
  });

  const png = (width, height) =>
    sharp({
      create: { width, height, channels: 3, background: { r: 200, g: 50, b: 50 } },
    })
      .png()
      .toBuffer();

  const serve = (body, headers = {}) => (req, res) => {
    res.writeHead(200, { "Content-Type": "image/png", ...headers });
    res.end(body);
  };

  it("fetches an image, re-encoded, with its caching headers", async function () {
    const image = await png(40, 30);
    routes["/image.png"] = serve(image, {
      ETag: '"abc"',
      "Last-Modified": "Wed, 01 Jan 2020 00:00:00 GMT",
      "Cache-Control": "max-age=60",
      "Set-Cookie": "not=wanted",
    });

    const { meta, outputs } = await fetchImage({ url: origin + "/image.png" });

    expect(meta.error).toBeUndefined();
    expect(meta.status).toBe(200);
    expect(meta.format).toBe("png");
    expect([meta.width, meta.height]).toEqual([40, 30]);
    expect(meta.headers).toEqual({
      etag: '"abc"',
      lastModified: "Wed, 01 Jan 2020 00:00:00 GMT",
      cacheControl: "max-age=60",
    });
    expect(outputs.length).toBe(1);
    const info = await sharp(outputs[0]).metadata();
    expect([info.format, info.width, info.height]).toEqual(["png", 40, 30]);
  });

  it("keeps a JPEG a JPEG and applies its orientation", async function () {
    const jpeg = await sharp({
      create: { width: 60, height: 20, channels: 3, background: "#336699" },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    routes["/photo"] = serve(jpeg, { "Content-Type": "application/octet-stream" });

    const { meta, outputs } = await fetchImage({ url: origin + "/photo" });

    expect(meta.format).toBe("jpeg");
    expect([meta.width, meta.height]).toEqual([20, 60]);
    const info = await sharp(outputs[0]).metadata();
    expect(info.orientation).toBeUndefined();
  });

  it("shrinks an image to fit inside the size its callers use", async function () {
    const wide = await png(MAX_DIMENSION * 2, 10);
    routes["/wide.png"] = serve(wide);

    const { meta, outputs } = await fetchImage({ url: origin + "/wide.png" });

    expect([meta.width, meta.height]).toEqual([MAX_DIMENSION, 5]);
    const info = await sharp(outputs[0]).metadata();
    expect([info.width, info.height]).toEqual([MAX_DIMENSION, 5]);
  });

  it("keeps an animated GIF animated", async function () {
    const frame = (background) =>
      sharp({ create: { width: 20, height: 10, channels: 3, background } }).png().toBuffer();
    const gif = await sharp([await frame("#ff0000"), await frame("#00ff00")], {
      join: { animated: true },
    })
      .gif()
      .toBuffer();
    routes["/animated.gif"] = serve(gif, { "Content-Type": "image/gif" });

    const { meta, outputs } = await fetchImage({ url: origin + "/animated.gif" });

    expect(meta.format).toBe("gif");
    expect([meta.width, meta.height]).toEqual([20, 10]);
    expect((await sharp(outputs[0], { animated: true }).metadata()).pages).toBe(2);
  });

  it("decodes a gzip body", async function () {
    const image = await png(10, 10);
    routes["/gzip"] = (req, res) => {
      res.writeHead(200, { "Content-Encoding": "gzip" });
      res.end(zlib.gzipSync(image));
    };

    const { meta } = await fetchImage({ url: origin + "/gzip" });
    expect(meta.error).toBeUndefined();
    expect(meta.format).toBe("png");
  });

  it("follows redirects, up to its limit", async function () {
    const image = await png(10, 10);
    routes["/image.png"] = serve(image);
    for (let i = 1; i <= MAX_REDIRECTS + 1; i++) {
      const next = i === 1 ? "/image.png" : `/hop-${i - 1}`;
      routes[`/hop-${i}`] = (req, res) => {
        res.writeHead(302, { Location: next });
        res.end();
      };
    }

    const followed = await fetchImage({ url: `${origin}/hop-${MAX_REDIRECTS}` });
    expect(followed.meta.error).toBeUndefined();
    expect(followed.outputs.length).toBe(1);

    const tooMany = await fetchImage({ url: `${origin}/hop-${MAX_REDIRECTS + 1}` });
    expect(tooMany.meta.error).toBe("too many redirects");
    expect(tooMany.outputs).toEqual([]);
  });

  it("never follows a redirect off http(s) or to a URL with credentials", async function () {
    routes["/to-file"] = (req, res) => {
      res.writeHead(301, { Location: "file:///etc/passwd" });
      res.end();
    };
    routes["/to-credentials"] = (req, res) => {
      res.writeHead(301, { Location: `http://user:secret@127.0.0.1:1/` });
      res.end();
    };

    expect((await fetchImage({ url: origin + "/to-file" })).meta.error).toBe("URL is not allowed");
    expect((await fetchImage({ url: origin + "/to-credentials" })).meta.error).toBe(
      "URL must not contain credentials"
    );
  });

  it("stops a gzip bomb once it has inflated past the limit", async function () {
    const bomb = zlib.gzipSync(Buffer.alloc(MAX_DECODED_BYTES + MiB));
    expect(bomb.length).toBeLessThan(MiB);
    routes["/bomb"] = (req, res) => {
      res.writeHead(200, { "Content-Encoding": "gzip", "Content-Length": bomb.length });
      res.end(bomb);
    };

    const { meta, outputs } = await fetchImage({ url: origin + "/bomb" });
    expect(meta.error).toBe("image is too large");
    expect(outputs).toEqual([]);
  });

  it("stops a brotli bomb once it has inflated past the limit", async function () {
    const bomb = zlib.brotliCompressSync(Buffer.alloc(MAX_DECODED_BYTES + MiB), {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 1 },
    });
    routes["/bomb"] = (req, res) => {
      res.writeHead(200, { "Content-Encoding": "br" });
      res.end(bomb);
    };

    const { meta } = await fetchImage({ url: origin + "/bomb" });
    expect(meta.error).toBe("image is too large");
  });

  it("refuses a body that says it is too large, or turns out to be", async function () {
    routes["/declared"] = (req, res) => {
      res.writeHead(200, { "Content-Length": String(64 * MiB) });
      res.end();
    };
    routes["/chunked"] = (req, res) => {
      res.writeHead(200);
      const chunk = Buffer.alloc(MiB);
      let sent = 0;
      const write = () => {
        while (sent < 40 && !res.destroyed) {
          sent++;
          if (!res.write(chunk)) return res.once("drain", write);
        }
        res.end();
      };
      res.on("error", () => {});
      write();
    };

    expect((await fetchImage({ url: origin + "/declared" })).meta.error).toBe("image is too large");
    expect((await fetchImage({ url: origin + "/chunked" })).meta.error).toBe("image is too large");
  });

  it("refuses a body that isn't an image, or is SVG", async function () {
    routes["/page.png"] = serve(Buffer.from("<html><body>hello</body></html>"));
    routes["/drawing.svg"] = serve(
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'),
      { "Content-Type": "image/svg+xml" }
    );

    const page = await fetchImage({ url: origin + "/page.png" });
    expect(page.meta.error).toBe("not an image");
    expect(page.outputs).toEqual([]);

    const svg = await fetchImage({ url: origin + "/drawing.svg" });
    expect(svg.meta.error).toBe("not a supported image format");
  });

  it("refuses an image with too many pixels before decoding it", async function () {
    const huge = await sharp({
      create: { width: 6000, height: 4100, channels: 3, background: "#000000" },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    routes["/huge.png"] = serve(huge);
    // fewer pixels, but the limit is lower for what is decoded whole
    const create = { width: 3700, height: 3500, channels: 3, background: "#000000" };
    routes["/huge.webp"] = serve(await sharp({ create }).webp().toBuffer());
    routes["/progressive.jpg"] = serve(
      await sharp({ create }).jpeg({ progressive: true, chromaSubsampling: "4:4:4" }).toBuffer()
    );
    routes["/interlaced.png"] = serve(await sharp({ create }).png({ progressive: true }).toBuffer());
    // ...unless a progressive JPEG's chroma is subsampled
    routes["/progressive-420.jpg"] = serve(
      await sharp({ create }).jpeg({ progressive: true, chromaSubsampling: "4:2:0" }).toBuffer()
    );

    for (const name of ["huge.png", "huge.webp", "progressive.jpg", "interlaced.png"]) {
      expect((await fetchImage({ url: `${origin}/${name}` })).meta.error).toBe("image is too large");
    }
    expect((await fetchImage({ url: origin + "/progressive-420.jpg" })).meta.format).toBe("jpeg");
  });

  it("reports a bad status, and a body cut short", async function () {
    routes["/cut"] = (req, res) => {
      res.writeHead(200, { "Content-Length": "1000" });
      res.write("partial");
      setTimeout(() => res.socket.destroy(), 50);
    };

    const missing = await fetchImage({ url: origin + "/missing.png" });
    expect(missing.meta).toEqual({ error: "404", status: 404 });

    const cut = await fetchImage({ url: origin + "/cut" });
    expect(cut.meta.error).toBe("download was cut short");
  });

  it("sends the conditional headers it is given and answers a 304 with no image", async function () {
    routes["/cached.png"] = (req, res) => {
      res.writeHead(304, { ETag: '"v1"' });
      res.end();
    };

    const { meta, outputs } = await fetchImage({
      url: origin + "/cached.png",
      etag: '"v1"',
      lastModified: "Wed, 01 Jan 2020 00:00:00 GMT",
    });

    expect(meta).toEqual({ status: 304, headers: { etag: '"v1"' } });
    expect(outputs).toEqual([]);
    expect(requests[0].headers["if-none-match"]).toBe('"v1"');
    expect(requests[0].headers["if-modified-since"]).toBe("Wed, 01 Jan 2020 00:00:00 GMT");
  });

  it("checks its arguments", async function () {
    for (const args of [
      null,
      {},
      { url: 42 },
      { url: "file:///etc/passwd" },
      { url: "ftp://example.com/a.png" },
      { url: "not a url" },
      { url: "http://example.com/" + "a".repeat(3000) },
    ]) {
      const { meta, outputs } = await fetchImage(args);
      expect(meta.error).toBe("URL is not allowed");
      expect(outputs).toEqual([]);
    }

    expect((await fetchImage({ url: "http://user:pass@example.com/a.png" })).meta.error).toBe(
      "URL must not contain credentials"
    );
    for (const etag of ['"a"\r\nX-Injected: 1', 42, "x".repeat(600)]) {
      expect((await fetchImage({ url: origin + "/a.png", etag })).meta.error).toBe(
        "invalid conditional header"
      );
    }
    expect(requests.length).toBe(0);
  });

  it("reports a connection that is refused with its code", async function () {
    const closed = http.createServer();
    await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const { port } = closed.address();
    await new Promise((resolve) => closed.close(resolve));

    const { meta } = await fetchImage({ url: `http://127.0.0.1:${port}/a.png` });
    expect(meta.code).toBe("ECONNREFUSED");
  });
});
