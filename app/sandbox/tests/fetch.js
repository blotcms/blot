describe("sandbox fetch job", function () {
  const http = require("http");
  const zlib = require("zlib");
  const sharp = require("sharp");
  const config = require("config");
  const sandbox = require("../");
  const sandboxFetch = require("../fetch");
  const { MAX_REDIRECTS } = require("../jobs/fetching");
  const { MAX_REQUESTS, BATCH_BYTES, TEXT_MAX_BYTES } = require("../jobs/fetch");

  const MiB = 1024 * 1024;
  const empty = Buffer.alloc(0);

  let socket, server, origin, routes, requests;

  const batch = (list) => sandbox.run("fetch", { requests: list }, empty);

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

  const send = (body, headers = {}) => (req, res) => {
    res.writeHead(200, headers);
    res.end(body);
  };
  const png = (width, height) =>
    sharp({ create: { width, height, channels: 3, background: { r: 200, g: 50, b: 50 } } })
      .png()
      .toBuffer();

  describe("a batch", function () {
    it("answers every URL in order, with its own body", async function () {
      for (const name of ["a", "b", "c"]) routes["/" + name] = send(name.repeat(3));

      const { meta, outputs } = await batch(["a", "b", "c"].map((name) => ({ url: `${origin}/${name}` })));

      expect(meta.results.map((r) => r.status)).toEqual([200, 200, 200]);
      expect(outputs.map(String)).toEqual(["aaa", "bbb", "ccc"]);
      expect(meta.results.every((r) => r.kind === "text")).toBe(true);
      // one after the other, in order
      expect(requests.map((r) => r.url)).toEqual(["/a", "/b", "/c"]);
    });

    it("answers a URL that fails by itself, and goes on with the rest", async function () {
      routes["/ok"] = send("fine");
      routes["/boom"] = (req, res) => {
        res.statusCode = 500;
        res.end("no");
      };

      const { meta, outputs } = await batch([
        { url: origin + "/boom" },
        { url: "ftp://example.com/file" },
        { url: "http://user:pass@example.com/" },
        { url: origin + "/missing" },
        { url: "http://127.0.0.1:1/" },
        { url: origin + "/ok" },
      ]);

      expect(meta.results[0]).toEqual(jasmine.objectContaining({ error: "500", status: 500 }));
      expect(meta.results[1].error).toBe("URL is not allowed");
      expect(meta.results[2].error).toBe("URL must not contain credentials");
      expect(meta.results[3]).toEqual(jasmine.objectContaining({ error: "404", status: 404 }));
      expect(meta.results[4].code).toBe("ECONNREFUSED");
      expect(meta.results[5].status).toBe(200);
      expect(outputs.map((o) => o.length)).toEqual([0, 0, 0, 0, 0, 4]);
      expect(String(outputs[5])).toBe("fine");
    });

    it("keeps a response whatever its status when asked", async function () {
      routes["/gone"] = (req, res) => {
        res.statusCode = 410;
        res.end("it is gone");
      };

      const { meta, outputs } = await batch([{ url: origin + "/gone", anyStatus: true }]);

      expect(meta.results[0].status).toBe(410);
      expect(String(outputs[0])).toBe("it is gone");
    });

    it("refuses a list that is empty, too long or not a list", async function () {
      const tooMany = Array.from({ length: MAX_REQUESTS + 1 }, () => ({ url: origin + "/" }));
      for (const requests of [[], tooMany, "http://example.com", null, undefined]) {
        const { meta, outputs } = await sandbox.run("fetch", { requests }, empty);
        expect(meta.error).toMatch(/requests must be a list/);
        expect(outputs).toEqual([]);
      }
      expect((await sandbox.run("fetch", null, empty)).meta.error).toMatch(/requests must be a list/);
    });

    it("checks each request's options", async function () {
      const bad = [
        { url: origin + "/", kind: "video" },
        { url: origin + "/", method: "POST" },
        { url: origin + "/", redirect: "error" },
        { url: origin + "/", ip: "not an address" },
        { url: origin + "/", check: "exe" },
        { url: origin + "/", maxBytes: -1 },
        { url: origin + "/", headers: { userAgent: "bad\r\nHeader: yes" } },
        null,
        "http://example.com/",
      ];
      const { meta } = await batch(bad);
      expect(meta.results.length).toBe(bad.length);
      expect(meta.results.every((r) => r.error && !r.deferred)).toBe(true);
      expect(requests.length).toBe(0);
    });

    it("sends only the headers it allows", async function () {
      routes["/headers"] = (req, res) => res.end(JSON.stringify(req.headers));

      const { outputs } = await batch([
        {
          url: origin + "/headers",
          headers: { userAgent: "Blot (+https://blot.im)", referer: "https://www.are.na/", accept: "image/*", cookie: "a=b" },
        },
        { url: origin + "/headers" },
      ]);

      const first = JSON.parse(outputs[0]);
      expect(first["user-agent"]).toBe("Blot (+https://blot.im)");
      expect(first.referer).toBe("https://www.are.na/");
      expect(first.accept).toBe("image/*");
      expect(first.cookie).toBeUndefined();
      expect(first["accept-encoding"]).toBe("gzip, deflate, br");
      const second = JSON.parse(outputs[1]);
      expect(second["user-agent"]).toBe("node-fetch");
      expect(second.referer).toBeUndefined();
    });

    it("puts off what doesn't fit beside the bodies it has kept, and never the first", async function () {
      const big = Buffer.alloc(BATCH_BYTES - 10, "x");
      routes["/big"] = send(big);
      routes["/small"] = send("tiny");
      routes["/more"] = send(Buffer.alloc(100, "y"));

      const { meta, outputs } = await batch([
        { url: origin + "/big", kind: "file", maxBytes: 20 * MiB },
        { url: origin + "/small", kind: "file" },
        { url: origin + "/more", kind: "file" },
      ]);

      expect(meta.results[0].status).toBe(200);
      expect(outputs[0].length).toBe(big.length);
      expect(meta.results[1].status).toBe(200);
      expect(meta.results[2]).toEqual(jasmine.objectContaining({ error: "batch is full", deferred: true }));
      expect(outputs[2].length).toBe(0);
    });

    it("gives a first body larger than the others' room all of its own limit", async function () {
      routes["/large"] = send(Buffer.alloc(BATCH_BYTES + MiB, "z"));
      const { meta, outputs } = await batch([{ url: origin + "/large", kind: "file" }]);
      expect(meta.results[0].error).toBeUndefined();
      expect(outputs[0].length).toBe(BATCH_BYTES + MiB);
    });
  });

  describe("the batch's time", function () {
    it("puts off a request that would have less than its whole time, instead of cutting it short", async function () {
      const real = Date.now.bind(Date);
      let offset = 0;
      spyOn(Date, "now").and.callFake(() => real() + offset);
      routes["/first"] = (req, res) => {
        offset = 58 * 1000; // the batch has 2s of its 60s left
        res.end("first");
      };
      routes["/second"] = send("second");

      const { meta, outputs } = await batch([
        { url: origin + "/first" },
        { url: origin + "/second", timeoutMs: 5000 },
        { url: origin + "/second", timeoutMs: 1000 },
      ]);

      expect(String(outputs[0])).toBe("first");
      expect(meta.results[1]).toEqual(jasmine.objectContaining({ deferred: true, error: "batch timed out" }));
      expect(meta.results[1].timedOut).toBeUndefined();
      // one that fits in what is left is fetched
      expect(meta.results[2].status).toBe(200);
    });

    it("sends a put-off request again, in a jail of its own, with its whole time", async function () {
      const real = Date.now.bind(Date);
      let offset = 0;
      spyOn(Date, "now").and.callFake(() => real() + offset);
      routes["/first"] = (req, res) => {
        offset = 58 * 1000;
        res.end("first");
      };
      routes["/second"] = (req, res) => {
        offset = 0;
        res.end("second");
      };
      spyOn(sandbox, "run").and.callThrough();

      const results = await sandboxFetch.many([
        { url: origin + "/first" },
        { url: origin + "/second", timeoutMs: 5000 },
      ]);

      expect(results.map((r) => r.text)).toEqual(["first", "second"]);
      expect(sandbox.run).toHaveBeenCalledTimes(2);
    });
  });

  describe("text", function () {
    it("returns the body decompressed, with the caching and type headers", async function () {
      routes["/page"] = send(zlib.gzipSync("<p>hello</p>"), {
        "Content-Encoding": "gzip",
        "Content-Type": "text/html; charset=utf-8",
        ETag: '"abc"',
        "Set-Cookie": "not=wanted",
      });

      const { meta, outputs } = await batch([{ url: origin + "/page" }]);

      expect(String(outputs[0])).toBe("<p>hello</p>");
      expect(meta.results[0].headers).toEqual({ etag: '"abc"', contentType: "text/html; charset=utf-8" });
    });

    it("stops a gzip bomb once it has inflated past its limit", async function () {
      routes["/bomb"] = send(zlib.gzipSync(Buffer.alloc(3 * MiB)), { "Content-Encoding": "gzip" });
      routes["/brotli"] = send(zlib.brotliCompressSync(Buffer.alloc(3 * MiB)), { "Content-Encoding": "br" });
      routes["/deflate"] = send(zlib.deflateSync(Buffer.alloc(3 * MiB)), { "Content-Encoding": "deflate" });
      routes["/fine"] = send(zlib.gzipSync(Buffer.alloc(0.5 * MiB, "a")), { "Content-Encoding": "gzip" });

      const { meta, outputs } = await batch(
        ["/bomb", "/brotli", "/deflate"].map((path) => ({ url: origin + path, maxBytes: 1 * MiB })).concat({
          url: origin + "/fine",
          maxBytes: 1 * MiB,
        })
      );

      expect(meta.results.slice(0, 3).map((r) => r.error)).toEqual(Array(3).fill("response is too large"));
      expect(meta.results[3].error).toBeUndefined();
      expect(outputs[3].length).toBe(0.5 * MiB);
    });

    it("refuses a body that says it is too large before reading it", async function () {
      let sent = 0;
      routes["/declared"] = (req, res) => {
        res.writeHead(200, { "Content-Length": 5 * MiB });
        res.write(Buffer.alloc(1024));
        sent += 1024;
        res.on("close", () => {});
      };

      const { meta } = await batch([{ url: origin + "/declared", maxBytes: 1 * MiB }]);

      expect(meta.results[0].error).toBe("response is too large");
      expect(sent).toBe(1024);
    });

    it("never reads more than its hard limit, whatever it is asked for", async function () {
      routes["/huge"] = send(Buffer.alloc(TEXT_MAX_BYTES + 1, "a"));
      const { meta } = await batch([{ url: origin + "/huge", maxBytes: 1024 * MiB }]);
      expect(meta.results[0].error).toBe("response is too large");
    });

    it("can stop at its limit and keep what it has read", async function () {
      routes["/long"] = send("0123456789".repeat(100), { "Content-Encoding": "identity" });
      routes["/longgz"] = send(zlib.gzipSync("0123456789".repeat(100)), { "Content-Encoding": "gzip" });

      const { meta, outputs } = await batch([
        { url: origin + "/long", maxBytes: 25, truncate: true },
        { url: origin + "/longgz", maxBytes: 25, truncate: true },
        { url: origin + "/long", maxBytes: 5000, truncate: true },
      ]);

      expect(String(outputs[0])).toBe("0123456789012345678901234");
      expect(meta.results[0].truncated).toBe(true);
      expect(String(outputs[1])).toBe("0123456789012345678901234");
      expect(meta.results[2].truncated).toBeUndefined();
      expect(outputs[2].length).toBe(1000);
    });

    it("answers a HEAD request without a body", async function () {
      routes["/head"] = (req, res) => {
        res.writeHead(200, { "Content-Length": 1000, ETag: '"h"' });
        res.end();
      };

      const { meta, outputs } = await batch([{ url: origin + "/head", method: "HEAD" }]);

      expect(requests[0].method).toBe("HEAD");
      expect(meta.results[0].status).toBe(200);
      expect(meta.results[0].headers.etag).toBe('"h"');
      expect(outputs[0].length).toBe(0);
    });
  });

  describe("redirects", function () {
    it("follows them, up to its limit", async function () {
      routes["/end"] = send("arrived");
      for (let i = 0; i < MAX_REDIRECTS + 1; i++) {
        routes["/hop" + i] = (req, res) => {
          res.writeHead(302, { Location: i === MAX_REDIRECTS ? "/end" : "/hop" + (i + 1) });
          res.end();
        };
      }

      const { meta, outputs } = await batch([{ url: origin + "/hop1" }, { url: origin + "/hop0" }]);

      expect(String(outputs[0])).toBe("arrived");
      expect(meta.results[1].error).toBe("too many redirects");
    });

    it("never follows one off http(s) or to a URL with credentials", async function () {
      routes["/ftp"] = (req, res) => {
        res.writeHead(302, { Location: "ftp://example.com/file" });
        res.end();
      };
      routes["/creds"] = (req, res) => {
        res.writeHead(302, { Location: "http://user:pass@example.com/" });
        res.end();
      };

      const { meta } = await batch([{ url: origin + "/ftp" }, { url: origin + "/creds" }]);

      expect(meta.results[0].error).toBe("URL is not allowed");
      expect(meta.results[1].error).toBe("URL must not contain credentials");
    });

    it("hands back a redirect it is told not to follow", async function () {
      routes["/moved"] = (req, res) => {
        res.writeHead(301, { Location: "https://example.com/new" });
        res.end("moved");
      };

      const { meta, outputs } = await batch([
        { url: origin + "/moved", redirect: "manual", anyStatus: true },
        { url: origin + "/moved", redirect: "manual" },
      ]);

      expect(meta.results[0].status).toBe(301);
      expect(meta.results[0].headers.location).toBe("https://example.com/new");
      expect(outputs[0].length).toBe(0);
      expect(meta.results[1].error).toBe("301");
      expect(requests.length).toBe(2);
    });
  });

  describe("a pinned address", function () {
    it("connects to the address and sends the URL's host", async function () {
      routes["/verify/domain-setup"] = (req, res) => res.end(req.headers.host);
      const { port } = server.address();

      const { meta, outputs } = await batch([
        { url: `http://blog.example.test:${port}/verify/domain-setup`, ip: "127.0.0.1" },
      ]);

      expect(meta.results[0].error).toBeUndefined();
      expect(String(outputs[0])).toBe(`blog.example.test:${port}`);
    });

    it("doesn't resolve the name when it is pinned, and does when it isn't", async function () {
      const { port } = server.address();
      const { meta } = await batch([
        { url: `http://no-such-name.invalid:${port}/` },
        { url: `http://no-such-name.invalid:${port}/`, ip: "127.0.0.1", anyStatus: true },
      ]);

      expect(meta.results[0].code).toMatch(/ENOTFOUND|EAI_AGAIN/);
      expect(meta.results[1].status).toBe(404);
    });

    it("pins only the first request: a redirect goes where the server says", async function () {
      const { port } = server.address();
      routes["/start"] = (req, res) => {
        res.writeHead(302, { Location: `http://elsewhere.invalid:${port}/next` });
        res.end();
      };
      routes["/next"] = send("never");

      const { meta } = await batch([{ url: `http://pinned.example.test:${port}/start`, ip: "127.0.0.1" }]);

      expect(meta.results[0].code).toMatch(/ENOTFOUND|EAI_AGAIN/);
      expect(requests.map((r) => r.url)).toEqual(["/start"]);
    });

    it("reports a pinned address that refuses the connection with its code", async function () {
      const { meta } = await batch([{ url: "http://blog.example.test:1/", ip: "127.0.0.1" }]);
      expect(meta.results[0].code).toBe("ECONNREFUSED");
    });
  });

  describe("files", function () {
    const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(200, "x")]);

    it("returns the bytes of a PDF or audio file, and refuses what is not one", async function () {
      routes["/doc.pdf"] = send(pdf, { "Content-Type": "application/pdf" });
      routes["/fake.pdf"] = send("<html>log in</html>", { "Content-Type": "application/pdf" });
      routes["/song.mp3"] = send(Buffer.concat([Buffer.from("ID3"), Buffer.alloc(300, 1)]));
      routes["/page.mp3"] = send("  <!doctype html><title>no</title>", { "Content-Type": "audio/mpeg" });

      const { meta, outputs } = await batch([
        { url: origin + "/doc.pdf", kind: "file", check: "pdf" },
        { url: origin + "/fake.pdf", kind: "file", check: "pdf" },
        { url: origin + "/song.mp3", kind: "file", check: "audio" },
        { url: origin + "/page.mp3", kind: "file", check: "audio" },
      ]);

      expect(outputs[0].equals(pdf)).toBe(true);
      expect(meta.results[0].kind).toBe("file");
      expect(meta.results[1].error).toBe("not a PDF");
      expect(outputs[2].length).toBe(303);
      expect(meta.results[3].error).toBe("not an audio file");
    });

    it("never hands back HTML, SVG, script or JSON as a file", async function () {
      const bodies = {
        html: "<!DOCTYPE html><html></html>",
        svg: '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>',
        svg2: '﻿  <svg onload="alert(1)"></svg>',
        script: "<script>alert(1)</script>",
        late: "x".repeat(100) + "<html><body>hi</body></html>",
        json: '{"login":"required"}',
      };
      for (const [name, body] of Object.entries(bodies)) routes["/" + name] = send(body);

      const { meta } = await batch(Object.keys(bodies).map((name) => ({ url: `${origin}/${name}`, kind: "file" })));

      expect(meta.results.map((r) => r.error)).toEqual(Array(Object.keys(bodies).length).fill("not a file"));
    });

    it("stops a file at its limit, compressed or not", async function () {
      routes["/long"] = send(Buffer.alloc(2048, 1));
      routes["/longgz"] = send(zlib.gzipSync(Buffer.alloc(1 * MiB, 1)), { "Content-Encoding": "gzip" });

      const { meta } = await batch([
        { url: origin + "/long", kind: "file", maxBytes: 1024 },
        { url: origin + "/longgz", kind: "file", maxBytes: 4096 },
      ]);

      expect(meta.results.map((r) => r.error)).toEqual(["file is too large", "file is too large"]);
    });
  });

  describe("images", function () {
    it("re-encodes an image, with its format and size", async function () {
      const image = await png(40, 30);
      routes["/image"] = send(image, { "Content-Type": "application/octet-stream", "Content-Disposition": 'inline; filename="x.png"' });
      routes["/page"] = send("<p>not an image</p>");
      routes["/wide"] = send(await png(6000, 10));

      const { meta, outputs } = await batch([
        { url: origin + "/image", kind: "image" },
        { url: origin + "/page", kind: "image" },
        { url: origin + "/wide", kind: "image" },
      ]);

      expect(meta.results[0]).toEqual(
        jasmine.objectContaining({ kind: "image", format: "png", width: 40, height: 30 })
      );
      expect(meta.results[0].headers.contentDisposition).toBe('inline; filename="x.png"');
      const info = await sharp(outputs[0]).metadata();
      expect([info.format, info.width, info.height]).toEqual(["png", 40, 30]);
      expect(meta.results[1].error).toBe("not an image");
      expect([meta.results[2].width, meta.results[2].height]).toEqual([3000, 5]);
    });

    it("refuses an SVG, which would stay an SVG", async function () {
      routes["/vector"] = send('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
      const { meta } = await batch([{ url: origin + "/vector", kind: "image" }]);
      expect(meta.results[0].error).toBeTruthy();
    });
  });

  describe("html pages", function () {
    const page = (tags, body = "") => `<!doctype html><html><head>${tags}</head><body>${body}</body></html>`;
    const player =
      '<meta property="og:video" content="https://bandcamp.com/EmbeddedPlayer/v=2/album=1/">' +
      '<meta property="og:video:width" content="400"><meta property="og:video:height" content="120">';
    const html = (url, extra) => ({ url, kind: "html", extract: "og-video", ...extra });

    it("returns the named extraction of the page, never the page", async function () {
      routes["/album"] = send(page(player, "<p>" + "x".repeat(1000) + "</p>"), { "content-type": "text/html" });

      const { meta, outputs } = await batch([html(origin + "/album")]);

      expect(meta.results[0]).toEqual({
        status: 200,
        kind: "html",
        headers: { contentType: "text/html" },
        extracted: { src: "https://bandcamp.com/EmbeddedPlayer/v=2/album=1/", width: 400, height: 120 },
      });
      expect(outputs[0].length).toBe(0);
    });

    it("answers a page with no player as an extraction with nothing in it", async function () {
      routes["/plain"] = send(page("<title>x</title>"));
      const { meta } = await batch([html(origin + "/plain")]);
      expect(meta.results[0].extracted).toEqual({});
    });

    it("answers what the page names that is not a player's address or size as nothing", async function () {
      routes["/hostile"] = send(
        page(
          '<meta property="og:video" content="javascript:alert(1)"><meta property="og:video:width" content="400px">' +
            '<meta property="og:video:height" content="-1">'
        )
      );
      const { meta } = await batch([html(origin + "/hostile")]);
      expect(meta.results[0].extracted).toEqual({});
    });

    it("needs a named extraction, and no other", async function () {
      routes["/album"] = send(page(player));
      for (const extract of [undefined, "", "meta", "constructor", "__proto__", "og-video; x"]) {
        const { meta } = await batch([{ url: origin + "/album", kind: "html", extract }]);
        expect(meta.results[0].error).toBe("unknown extraction");
      }
      expect(requests.length).toBe(0);
    });

    it("cuts a long page at maxBytes with truncate, and the head still answers", async function () {
      routes["/long"] = send(page(player, "x".repeat(3 * MiB)));
      const cut = await batch([html(origin + "/long", { truncate: true })]);
      expect(cut.meta.results[0].truncated).toBe(true);
      expect(cut.meta.results[0].extracted.width).toBe(400);

      const whole = await batch([html(origin + "/long")]);
      expect(whole.meta.results[0].error).toBe("response is too large");
    });

    it("does not fetch more than the extraction's limit, whatever maxBytes says", async function () {
      routes["/long"] = send(page(player, "x".repeat(3 * MiB)));
      const { meta } = await batch([html(origin + "/long", { maxBytes: 64 * MiB })]);
      expect(meta.results[0].error).toBe("response is too large");
    });

    it("answers a page that is too large, deep or full of tags to parse as an error of the fetch", async function () {
      routes["/deep"] = send(page(player, "<div>".repeat(29000)));
      routes["/tags"] = send(page(player, "<a></a>".repeat(30000)));
      routes["/attributes"] = send(page(player, "<img " + Array.from({ length: 50000 }, (_, i) => "a" + i).join(" ") + ">"));

      const { meta } = await batch(["deep", "tags", "attributes"].map((name) => html(origin + "/" + name)));

      expect(meta.results.map((r) => r.error)).toEqual([
        "markup is nested too deeply",
        "markup has too many tags",
        "markup has a tag with too many attributes",
      ]);
    });

    it("keeps the rest of the batch going after a page it can't parse", async function () {
      routes["/deep"] = send("<div>".repeat(29000));
      routes["/album"] = send(page(player));
      const { meta } = await batch([html(origin + "/deep"), html(origin + "/album")]);
      expect(meta.results[0].error).toBeTruthy();
      expect(meta.results[1].extracted.height).toBe(120);
    });

    it("refuses a status that is not 2xx and a redirect that is not followed, as other kinds do", async function () {
      routes["/gone"] = (req, res) => {
        res.statusCode = 404;
        res.end(page(player));
      };
      routes["/moved"] = (req, res) => {
        res.writeHead(302, { location: origin + "/album" });
        res.end();
      };
      routes["/album"] = send(page(player));

      const { meta } = await batch([html(origin + "/gone"), html(origin + "/moved", { redirect: "manual" })]);

      expect(meta.results[0]).toEqual({ error: jasmine.any(String), status: 404 });
      expect(meta.results[1].status).toBe(302);
      expect(meta.results[1].error).toBeTruthy();
      expect(requests.map((r) => r.url)).toEqual(["/gone", "/moved"]);
    });

    it("has nothing to extract from a HEAD", async function () {
      routes["/album"] = send(page(player));
      const { meta } = await batch([html(origin + "/album", { method: "HEAD" })]);
      expect(meta.results[0].status).toBe(200);
      expect(meta.results[0].extracted).toBeUndefined();
    });

    it("gives the client the extraction as `extracted`", async function () {
      routes["/album"] = send(page(player));
      const result = await sandboxFetch.one(html(origin + "/album"));
      expect(result.kind).toBe("html");
      expect(result.extracted).toEqual({ src: "https://bandcamp.com/EmbeddedPlayer/v=2/album=1/", width: 400, height: 120 });
      expect(result.data.length).toBe(0);
    });
  });

  describe("the client", function () {
    it("returns a result for each request, an error for one that failed", async function () {
      routes["/one"] = send("1", { ETag: '"1"' });

      const results = await sandboxFetch.many([
        { url: origin + "/one" },
        { url: origin + "/missing" },
        { url: "http://127.0.0.1:1/" },
        { url: origin + "/image", kind: "image" },
      ]);

      expect(results[0]).toEqual(jasmine.objectContaining({ ok: true, status: 200, text: "1", kind: "text" }));
      expect(results[0].data.toString()).toBe("1");
      expect(results[0].headers).toEqual({ etag: '"1"' });
      expect(results[1].ok).toBe(false);
      expect(results[1].error.message).toBe("404");
      expect(results[1].error.status).toBe(404);
      expect(results[2].error.code).toBe("ECONNREFUSED");
      expect(results[3].ok).toBe(false);
    });

    it("throws the error of a single request that failed", async function () {
      let error;
      try {
        await sandboxFetch.one({ url: origin + "/missing" });
      } catch (e) {
        error = e;
      }
      expect(error.message).toBe("404");
      expect(error.status).toBe(404);
    });

    it("marks a timeout, which the domain check reports as one", async function () {
      routes["/slow"] = () => {};

      let error;
      try {
        await sandboxFetch.one({ url: origin + "/slow", timeoutMs: 200 });
      } catch (e) {
        error = e;
      }
      expect(error.type).toBe("request-timeout");
    });

    it("sends again, in a jail of their own, the requests the job put off", async function () {
      const big = Buffer.alloc(BATCH_BYTES - 10, "x");
      routes["/big"] = send(big);
      routes["/a"] = send("aaaa");
      routes["/b"] = send("b".repeat(100));
      spyOn(sandbox, "run").and.callThrough();

      const results = await sandboxFetch.many([
        { url: origin + "/big", kind: "file", maxBytes: 20 * MiB },
        { url: origin + "/a", kind: "file" },
        { url: origin + "/b", kind: "file" },
      ]);

      expect(results.every((r) => r.ok)).toBe(true);
      expect(results[0].data.length).toBe(big.length);
      expect(String(results[1].data)).toBe("aaaa");
      expect(String(results[2].data)).toBe("b".repeat(100));
      expect(sandbox.run.calls.count()).toBe(2);
    });

    it("splits a long list into jails of at most MAX_REQUESTS", async function () {
      routes["/n"] = send("n");
      spyOn(sandbox, "run").and.callThrough();

      const results = await sandboxFetch.many(
        Array.from({ length: MAX_REQUESTS * 2 + 1 }, () => ({ url: origin + "/n" }))
      );

      expect(results.length).toBe(MAX_REQUESTS * 2 + 1);
      expect(results.every((r) => r.ok && r.text === "n")).toBe(true);
      expect(sandbox.run.calls.allArgs().map(([, args]) => args.requests.length)).toEqual([MAX_REQUESTS, MAX_REQUESTS, 1]);
    });

    it("starts no more jails once the signal aborts", async function () {
      const big = Buffer.alloc(BATCH_BYTES - 10, "x");
      routes["/big"] = send(big);
      routes["/small"] = send("b".repeat(100));
      const controller = new AbortController();
      spyOn(sandbox, "run").and.callFake(async (...args) => {
        const result = await sandbox.run.and.originalFn(...args);
        controller.abort(new Error("cancelled"));
        return result;
      });

      let error;
      try {
        await sandboxFetch.many(
          [
            { url: origin + "/big", kind: "file", maxBytes: 20 * MiB },
            { url: origin + "/small", kind: "file" },
            { url: origin + "/small", kind: "file" },
          ],
          { signal: controller.signal }
        );
      } catch (e) {
        error = e;
      }

      // the first jail kept the first body and put the rest off; the second was never started
      expect(error.message).toBe("cancelled");
      expect(sandbox.run).toHaveBeenCalledTimes(1);

      const aborted = new AbortController();
      aborted.abort();
      sandbox.run.calls.reset();
      await expectAsync(sandboxFetch.many([{ url: origin + "/small" }], { signal: aborted.signal })).toBeRejected();
      expect(sandbox.run).not.toHaveBeenCalled();
    });

    it("gives every request the sandbox's error when the sandbox fails", async function () {
      const failure = Object.assign(new Error("sandbox: busy"), { code: "SANDBOX_BUSY" });
      spyOn(sandbox, "run").and.returnValue(Promise.reject(failure));

      const results = await sandboxFetch.many([{ url: origin + "/a" }, { url: origin + "/b" }]);

      expect(results.map((r) => r.ok)).toEqual([false, false]);
      expect(results[0].error.code).toBe("SANDBOX_BUSY");
      let thrown;
      try {
        await sandboxFetch.one({ url: origin + "/a" });
      } catch (e) {
        thrown = e;
      }
      expect(thrown.code).toBe("SANDBOX_BUSY");
    });

    it("refuses, as the egress boundary did, where production has no sandbox", async function () {
      const required = config.egress.required;
      config.egress.required = true;
      spyOn(sandbox, "run");
      try {
        let error;
        try {
          await sandboxFetch.one({ url: origin + "/a" }, { label: "specs" });
        } catch (e) {
          error = e;
        }
        expect(error.message).toMatch(/no sandbox.*|refusing to fetch/);
        expect(error.message).toMatch(/specs/);
        expect(sandbox.run).not.toHaveBeenCalled();
      } finally {
        config.egress.required = required;
      }
    });
  });
});
