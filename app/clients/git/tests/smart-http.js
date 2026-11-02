// The read side of the git client's HTTP endpoint, which smartHttp.js serves
// by running git upload-pack, checked with raw requests (headers, git's 0000
// probe, gzipped and corrupt bodies, a client going away) and with a real git
// client (shallow clones and fetches, protocol version 2 requested).
describe("git client smart HTTP reads", function () {
  require("./setup")({ clone: false, client: true, once: true });

  var crypto = require("crypto");
  var http = require("http");
  var zlib = require("zlib");
  var execFile = require("child_process").execFile;
  var repo = require("clients/git/repo");

  beforeAll(async function () {
    await this.local.commitFiles({ "/smart-http/one.txt": "One" });
    await this.local.commitFiles({ "/smart-http/two.txt": "Two" });
    await this.local.push();
    await this.local.expectSynced();
  });

  afterEach(async function () {
    await this.local.expectSynced();
  });

  function pktLine(content) {
    return ("0000" + (content.length + 4).toString(16)).slice(-4) + content;
  }

  // Sends a request to the endpoint with the spec's credentials and resolves
  // with { status, headers, body }
  function request(ctx, method, path, options) {
    options = options || {};

    var parsed = new URL(ctx.repoUrl);
    var auth = decodeURIComponent(parsed.username) + ":" + decodeURIComponent(parsed.password);

    return new Promise(function (resolve, reject) {
      var req = http.request(
        {
          method: method,
          hostname: "127.0.0.1",
          port: ctx.server.port,
          path: "/clients/git/end/" + ctx.blog.handle + ".git" + path,
          headers: Object.assign(
            { Authorization: "Basic " + Buffer.from(auth).toString("base64") },
            options.headers
          ),
        },
        function (res) {
          var chunks = [];

          res.on("data", function (chunk) {
            chunks.push(chunk);
          });
          res.on("end", function () {
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: Buffer.concat(chunks),
            });
          });
        }
      );

      req.on("error", reject);
      req.end(options.body);
    });
  }

  function upload(ctx, body, headers) {
    return request(ctx, "POST", "/git-upload-pack", {
      body: body,
      headers: Object.assign(
        { "Content-Type": "application/x-git-upload-pack-request" },
        headers
      ),
    });
  }

  // A request for the commit and everything under it
  async function fetchRequest(ctx) {
    var head = await ctx.local.remoteHead();

    return pktLine("want " + head + " ofs-delta\n") + "0000" + pktLine("done\n");
  }

  function expectNoCache(response) {
    expect(response.headers["cache-control"]).toBe("no-cache, max-age=0, must-revalidate");
    expect(response.headers.pragma).toBe("no-cache");
    expect(response.headers.expires).toBe("Fri, 01 Jan 1980 00:00:00 GMT");
  }

  describe("ref advertisement", function () {
    it("has the headers and body pushover gave", async function () {
      var response = await request(this, "GET", "/info/refs?service=git-upload-pack");
      var body = response.body.toString("latin1");

      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe("application/x-git-upload-pack-advertisement");
      expectNoCache(response);
      expect(body.indexOf("001e# service=git-upload-pack\n0000")).toBe(0);
      expect(body).toContain(await this.local.remoteHead() + " refs/heads/master");
    });

    it("is protocol version 0 even if the client asks for 2", async function () {
      var response = await request(this, "GET", "/info/refs?service=git-upload-pack", {
        headers: { "Git-Protocol": "version=2" },
      });
      var body = response.body.toString("latin1");

      expect(response.status).toBe(200);
      expect(body).not.toContain("version 2");
      expect(body).toContain(" HEAD\u0000");
    });

    it("offers only what the endpoint implements", async function () {
      var response = await request(this, "GET", "/info/refs?service=git-upload-pack");
      var capabilities = response.body.toString("latin1").split("\u0000")[1].split("\n")[0].split(" ");

      // Not configured, so not offered: partial clones and fetching by SHA-1
      ["filter", "allow-tip-sha1-in-want", "allow-reachable-sha1-in-want"].forEach(function (name) {
        expect(capabilities).not.toContain(name);
      });

      expect(capabilities).toContain("ofs-delta");
      expect(capabilities).toContain("side-band-64k");
    });

    it("accepts the service without its git- prefix", async function () {
      var response = await request(this, "GET", "/info/refs?service=upload-pack");

      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe("application/x-git-upload-pack-advertisement");
    });

    it("leaves a missing service to pushover", async function () {
      var response = await request(this, "GET", "/info/refs");

      expect(response.status).toBe(400);
      expect(response.body.toString()).toBe("service parameter required");
    });
  });

  describe("upload-pack", function () {
    it("answers git's 0000 probe with an empty result", async function () {
      var response = await upload(this, "0000");

      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe("application/x-git-upload-pack-result");
      expectNoCache(response);
      expect(response.body.length).toBe(0);
    });

    it("answers git's 0000 probe for receive-pack too", async function () {
      var response = await request(this, "POST", "/git-receive-pack", {
        body: "0000",
        headers: { "Content-Type": "application/x-git-receive-pack-request" },
      });

      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe("application/x-git-receive-pack-result");
      expectNoCache(response);
      expect(response.body.length).toBe(0);
    });

    it("sends a pack for a request", async function () {
      var response = await upload(this, await fetchRequest(this));

      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe("application/x-git-upload-pack-result");
      expectNoCache(response);
      expect(response.body.toString("latin1")).toContain("NAK");
      expect(response.body.toString("latin1")).toContain("PACK");
    });

    it("accepts a gzipped request", async function () {
      var response = await upload(this, zlib.gzipSync(await fetchRequest(this)), {
        "Content-Encoding": "gzip",
      });

      expect(response.status).toBe(200);
      expect(response.body.toString("latin1")).toContain("PACK");
    });

    it("ends a request with a corrupt gzip body, and carries on", async function () {
      var uncaught = [];
      var onUncaught = function (err) {
        uncaught.push(err);
      };

      process.on("uncaughtException", onUncaught);

      try {
        var corrupt = zlib.gzipSync(await fetchRequest(this));

        corrupt = Buffer.concat([corrupt.subarray(0, 10), Buffer.from("not gzip at all"), corrupt.subarray(10)]);

        var response = await upload(this, corrupt, { "Content-Encoding": "gzip" });

        expect(response.status).toBe(400);

        // and a body cut short
        response = await upload(this, zlib.gzipSync(await fetchRequest(this)).subarray(0, 12), {
          "Content-Encoding": "gzip",
        });

        expect(response.status).toBe(400);

        // The server is still serving
        expect((await this.local.git(["ls-remote", "origin"])).code).toBe(0);
        expect(uncaught.map(String)).toEqual([]);
      } finally {
        process.removeListener("uncaughtException", onUncaught);
      }
    });

    it("leaves other methods and services to pushover", async function () {
      var put = await request(this, "PUT", "/git-upload-pack");
      var unknown = await request(this, "POST", "/git-upload-pack?x=1", { body: "0000" });

      expect(put.status).toBe(405);
      expect(unknown.status).toBe(405);
    });
  });

  describe("a real client", function () {
    it("makes a shallow clone, with protocol version 2 requested", async function () {
      var clone = await this.local.cloneAgain({
        args: ["--depth", "1"],
        config: { "protocol.version": "2" },
      });

      expect((await clone.git(["rev-parse", "--is-shallow-repository"])).stdout.trim()).toBe("true");
      expect((await clone.git(["rev-list", "--count", "HEAD"])).stdout.trim()).toBe("1");
      expect(await clone.head()).toBe(await this.local.remoteHead());
    });

    it("deepens a shallow clone and fetches, with protocol version 2 requested", async function () {
      var clone = await this.local.cloneAgain({
        args: ["--depth", "1"],
        config: { "protocol.version": "2" },
      });

      await this.local.writeAndPush("/smart-http/after-clone.txt", "Pushed after the clone");
      await this.local.expectSynced();

      expect((await clone.git(["fetch", "--depth", "1", "origin"])).code).toBe(0);
      expect((await clone.git(["rev-parse", "origin/master"])).stdout.trim()).toBe(
        await this.local.remoteHead()
      );

      expect((await clone.git(["fetch", "--unshallow", "origin"])).code).toBe(0);
      expect(Number((await clone.git(["rev-list", "--count", "origin/master"])).stdout.trim())).toBeGreaterThan(2);
    });
  });

  describe("a client which goes away", function () {
    function uploadProcesses(directory) {
      return new Promise(function (resolve) {
        execFile("ps", ["-eo", "pid=,args="], function (err, stdout) {
          resolve(
            String(stdout || "")
              .split("\n")
              .filter(function (line) {
                // With or without the limiter's settings in front (git -c a=b ...)
                return /git(-|(\s+-c\s+\S+)*\s+)upload-pack/.test(line) && line.indexOf(directory) !== -1;
              })
          );
        });
      });
    }

    it("does not leave upload-pack running", async function () {
      var ctx = this;
      var directory = repo.directory(ctx.blog.handle);

      // A pack big enough that git is still writing when we leave
      await ctx.local.write("/smart-http/big.bin", crypto.randomBytes(16 * 1024 * 1024));
      await ctx.local.commit("Add a big file");
      await ctx.local.push();
      await ctx.local.waitForSync();

      var parsed = new URL(ctx.repoUrl);
      var auth = decodeURIComponent(parsed.username) + ":" + decodeURIComponent(parsed.password);
      var body = await fetchRequest(ctx);

      await new Promise(function (resolve) {
        var req = http.request(
          {
            method: "POST",
            hostname: "127.0.0.1",
            port: ctx.server.port,
            path: "/clients/git/end/" + ctx.blog.handle + ".git/git-upload-pack",
            headers: {
              Authorization: "Basic " + Buffer.from(auth).toString("base64"),
              "Content-Type": "application/x-git-upload-pack-request",
              "Content-Length": Buffer.byteLength(body),
            },
          },
          function (res) {
            // Take the start of the pack, then hang up without reading the rest
            res.once("data", function () {
              req.destroy();
              res.destroy();
            });
          }
        );

        req.on("error", function () {});
        req.on("close", resolve);
        req.end(body);
      });

      var deadline = Date.now() + 10 * 1000;
      var processes;

      do {
        processes = await uploadProcesses(directory);

        if (!processes.length) break;

        await new Promise(function (resolve) {
          setTimeout(resolve, 250);
        });
      } while (Date.now() < deadline);

      expect(processes).toEqual([]);
    });
  });
});
