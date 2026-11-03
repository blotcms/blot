const fs = require("fs");
const http = require("http");
const path = require("path");
const mustache = require("mustache");
const config = require("config");
const setup = require("./util/setup");
const { container } = require("../build/locals");

// Push progress (the "remote:" lines of a long push) and the packs of long
// clones must reach the client as they are written, not when the response is
// done. That needs the proxy to leave git's smart HTTP responses unbuffered and
// uncompressed, both on the route pushes and clones use
// (/clients/git/end/<handle>.git) and on the test-only read route served from
// the git store (/clients/git/store-end/<handle>.git, which falls under
// /clients).
describe("proxy git streaming", function () {
  const directory = path.join(__dirname, "../config");

  describe("configuration", function () {
    const partials = {};

    fs.readdirSync(directory)
      .filter((file) => file.endsWith(".conf"))
      .forEach((file) => {
        partials[file] = fs.readFileSync(path.join(directory, file), "utf8");
      });

    const rendered = mustache.render(
      "{{> blot-site.conf}}",
      container({ env: {}, config }),
      partials
    );

    // The text of the top-level location whose prefix is the longest one
    // which matches the path (no regex location matches git requests, which
    // push-limits.js checks)
    function locationFor(url) {
      const prefixes = (rendered.match(/\nlocation \/[^\s{]* \{/g) || [])
        .map((line) => line.slice("\nlocation ".length, -" {".length))
        .filter((prefix) => url.startsWith(prefix))
        .sort((a, b) => b.length - a.length);

      const start = rendered.indexOf("\nlocation " + prefixes[0] + " {");
      return rendered.slice(start, rendered.indexOf("\n}", start));
    }

    [
      "/clients/git/end/example.git/git-receive-pack",
      "/clients/git/end/example.git/git-upload-pack",
      "/clients/git/end/example.git/info/refs?service=git-upload-pack",
      "/clients/git/store-end/example.git/git-upload-pack",
      "/clients/git/store-end/example.git/info/refs?service=git-upload-pack",
    ].forEach((url) => {
      it("does not buffer " + url, function () {
        const block = locationFor(url);

        expect(block).toMatch(/proxy_pass /);
        expect(block).toMatch(/proxy_buffering off;/);
        expect(block).toMatch(/proxy_request_buffering off;/);
        expect(block).not.toMatch(/proxy_buffering on;/);
      });
    });

    it("does not compress git's content types", function () {
      const types = partials["static-file.conf"]
        .split("gzip_types")[1]
        .split(";")[0]
        .split(/\s+/)
        .filter(Boolean);

      expect(types.length).toBeGreaterThan(5);
      types.forEach((type) => expect(type).not.toMatch(/git/));
      expect(types).not.toContain("application/octet-stream");
      expect(types).not.toContain("*");
    });
  });

  describe("a response", function () {
    // How long the stub upstream waits between its first bytes and the rest
    const DELAY = 1000;

    let ended;

    // Writes a few bytes at once, as git does when it starts to answer, and
    // the rest (and the end) after DELAY
    const upstream = ({ port }) =>
      new Promise((resolve) => {
        const server = http.createServer((req, res) => {
          req.resume();
          res.writeHead(200, {
            "Content-Type": /info\/refs/.test(req.url)
              ? "application/x-git-upload-pack-advertisement"
              : "application/x-git-upload-pack-result",
            "Cache-Control": "no-cache",
          });
          res.write("0008NAK\n");

          setTimeout(() => {
            ended = Date.now();
            res.end("0013remote: done\n");
          }, DELAY);
        });

        server.listen(port, () => {
          const close = server.close.bind(server);
          server.close = (callback) => {
            server.closeAllConnections();
            return close(callback);
          };
          resolve(server);
        });
      });

    setup("./git-streaming.conf", { upstream });

    beforeEach(function () {
      ended = null;
    });

    // Resolves with when the first bytes arrived and when the response ended
    function request(origin, method, url, body, headers) {
      return new Promise((resolve, reject) => {
        const req = http.request(
          origin + url,
          { method, agent: false, headers: Object.assign({ "Accept-Encoding": "gzip" }, headers) },
          (res) => {
            const times = { status: res.statusCode, headers: res.headers, first: null, ended: null, body: "" };

            res.on("data", (chunk) => {
              if (times.first === null) times.first = Date.now();
              times.body += chunk;
            });
            res.on("end", () => {
              times.ended = Date.now();
              resolve(times);
            });
            res.on("error", reject);
          }
        );

        req.on("error", reject);
        req.end(body);
      });
    }

    [
      ["/clients/git/end/example.git", "the route for pushes and clones"],
      ["/clients/git/store-end/example.git", "the read route served from the store"],
    ].forEach(([repository, name]) => {
      [
        ["POST", "/git-receive-pack", "application/x-git-receive-pack-request"],
        ["POST", "/git-upload-pack", "application/x-git-upload-pack-request"],
        ["GET", "/info/refs?service=git-upload-pack", null],
      ].forEach(([method, suffix, type]) => {
        it("streams on " + name + ": " + method + " " + suffix, async function () {
          const times = await request(
            this.origin,
            method,
            repository + suffix,
            method === "POST" ? "0000" : undefined,
            type ? { "Content-Type": type } : {}
          );

          expect(times.status).toBe(200);
          expect(times.headers["content-encoding"]).toBeUndefined();
          expect(times.body).toBe("0008NAK\n0013remote: done\n");

          // The first bytes were here well before the response was over
          expect(ended).not.toBe(null);
          expect(times.first).toBeLessThan(ended - DELAY / 2);
          expect(times.ended).toBeGreaterThanOrEqual(ended);
        });
      });
    });
  });
});
