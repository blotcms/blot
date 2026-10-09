describe("git client process logging and limits", function () {
  // Sets up a clean test blog (this.blog) for each test,
  // sets the blog's client to git (this.client), then creates
  // a test server with the git client's routes exposed, then
  // cleans everything up when each test has finished.
  require("./setup")();

  var fs = require("fs-extra");
  var spawn = require("child_process").spawn;
  var EventEmitter = require("events");
  var PassThrough = require("stream").PassThrough;
  var guardServices = require("clients/git/guardServices");

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  // A push starts a sync of the blog folder once its response has finished.
  // Wait for that to end, otherwise it can still hold the folder lock when
  // the spec's cleanup deletes the blog, and its lost-lock error then fails
  // whichever spec happens to be running.
  async function waitForSync(ctx) {
    var syncUrl =
      "http://127.0.0.1:" +
      ctx.server.port +
      "/clients/git/syncs-finished/" +
      ctx.blog.id;

    for (var i = 0; i < 300; i++) {
      var finished = await new Promise(function (resolve, reject) {
        require("http")
          .get(syncUrl, function (res) {
            var body = "";
            res.setEncoding("utf8");
            res.on("data", function (chunk) {
              body += chunk;
            });
            res.on("end", function () {
              resolve(body === "true");
            });
          })
          .on("error", reject);
      });

      if (finished) return;

      await sleep(100);
    }

    throw new Error("Sync did not finish");
  }

  // The lines passed to console.log which were logged by the git client
  function gitLines(spy) {
    return spy.calls
      .allArgs()
      .map(function (args) {
        return args.join(" ");
      })
      .filter(function (line) {
        return line.indexOf(" Git: ") > -1;
      });
  }

  // The exit line is logged once git's pipes have closed, which can be just
  // after the client has seen the end of the response.
  async function waitForLines(spy, pattern) {
    for (var i = 0; i < 50; i++) {
      var lines = gitLines(spy).filter(function (line) {
        return pattern.test(line);
      });

      if (lines.length) return lines;

      await sleep(100);
    }

    return [];
  }

  // Git's configuration as seen by a process started the way pushover starts
  // git-receive-pack and git-upload-pack: no special environment or arguments.
  function gitConfig(key) {
    return new Promise(function (resolve, reject) {
      var child = spawn("git", ["config", "--type=int", "--get", key]);
      var output = "";

      child.stdout.on("data", function (chunk) {
        output += chunk;
      });
      child.on("error", reject);
      child.on("close", function () {
        resolve(output.trim());
      });
    });
  }

  describe("exit line", function () {
    it("logs one line when a push's git process exits", async function () {
      var ctx = this;
      var log = spyOn(console, "log").and.callThrough();

      await fs.outputFile(ctx.repoDirectory + "/hello.txt", "Hello, world");
      await ctx.git.add(".");
      await ctx.git.commit("add hello");
      await ctx.git.push();

      var lines = await waitForLines(log, /Git: receive-pack /);

      await waitForSync(ctx);

      expect(lines.length).toBe(1);
      expect(lines[0]).toContain(" Git: receive-pack " + ctx.blog.handle + " ");
      expect(lines[0]).toMatch(/ exit=0 duration=\d+\.\d{3}s rx=[1-9]\d* tx=\d+/);
      // a successful push has nothing on stderr
      expect(lines[0]).not.toContain("stderr=");

      // and it doesn't repeat itself
      await sleep(1500);
      expect(
        gitLines(log).filter(function (line) {
          return /Git: receive-pack /.test(line);
        }).length
      ).toBe(1);
    });

    it("logs a line for a fetch too", async function () {
      var ctx = this;
      var log = spyOn(console, "log").and.callThrough();

      await fs.outputFile(ctx.repoDirectory + "/hello.txt", "Hello, world");
      await ctx.git.add(".");
      await ctx.git.commit("add hello");
      await ctx.git.push();
      await waitForSync(ctx);

      var clone = require("simple-git")(ctx.tmp).silent(true);

      await clone.clone(ctx.repoUrl, ctx.tmp + "/second-clone");

      var lines = await waitForLines(log, /Git: upload-pack /);

      expect(lines.length).toBeGreaterThan(0);
      expect(lines[0]).toContain(" Git: upload-pack " + ctx.blog.handle + " exit=0 ");
    });
  });

  describe("logExit", function () {
    // Stands in for pushover's request/service and the spawned git process
    function fakeProcess() {
      var ps = new EventEmitter();

      ps.stdin = { bytesWritten: 1234 };
      ps.stdout = { bytesRead: 56 };
      ps.stderr = new PassThrough();

      return ps;
    }

    function fakeDuplex() {
      return {
        service: "receive-pack",
        request: {
          gitHandle: "example",
          headers: { "x-request-id": "0123456789abcdef0123456789abcdef" },
        },
      };
    }

    // Gives the stderr stream the chance to deliver what was written to it
    async function finish(ps, code, signal) {
      await sleep(10);
      ps.emit("exit", code, signal);
      ps.emit("close", code, signal);
    }

    it("includes the request ID, handle, exit code and the end of stderr", async function () {
      var log = spyOn(console, "log");
      var ps = fakeProcess();

      guardServices.logExit(fakeDuplex(), ps);
      ps.stderr.write("fatal: the pack is too large\n");
      await finish(ps, 128, null);

      expect(log.calls.count()).toBe(1);

      var line = log.calls.argsFor(0).join(" ");

      expect(line).toContain(" 0123456789abcdef0123456789abcdef Git: ");
      expect(line).toContain(" receive-pack example exit=128 ");
      expect(line).toContain(" rx=1234 tx=56");
      expect(line).toContain('stderr="fatal: the pack is too large\\n"');
    });

    it("reports the signal when the process was killed", async function () {
      var log = spyOn(console, "log");
      var ps = fakeProcess();

      guardServices.logExit(fakeDuplex(), ps);
      await finish(ps, null, "SIGTERM");

      expect(log.calls.argsFor(0).join(" ")).toContain(" exit=null signal=SIGTERM ");
    });

    it("logs once even if the process closes after it exits", async function () {
      var log = spyOn(console, "log");
      var ps = fakeProcess();

      guardServices.logExit(fakeDuplex(), ps);
      await finish(ps, 0, null);
      ps.emit("close", 0, null);

      expect(log.calls.count()).toBe(1);
    });

    it("keeps only the end of a large amount of stderr", async function () {
      var log = spyOn(console, "log");
      var ps = fakeProcess();
      var limit = guardServices.STDERR_TAIL_BYTES;

      guardServices.logExit(fakeDuplex(), ps);

      // 1000 lines of noise, then the line that matters
      for (var i = 0; i < 1000; i++) {
        ps.stderr.write("progress " + i + " ".repeat(100) + "\n");
      }

      ps.stderr.write("error: the last line\n");
      await finish(ps, 1, null);

      var line = log.calls.argsFor(0).join(" ");
      var stderr = JSON.parse(line.slice(line.indexOf("stderr=") + 7));

      expect(Buffer.byteLength(stderr)).toBeLessThanOrEqual(limit);
      expect(stderr).toContain("error: the last line");
      expect(stderr).not.toContain("progress 0 ");
    });
  });

  describe("createTail", function () {
    it("never holds more than its limit", function () {
      var tail = guardServices.createTail(10);

      tail.add(Buffer.from("0123456789abcdef"));
      expect(tail.toString()).toBe("6789abcdef");

      tail.add(Buffer.from("XY"));
      expect(tail.toString()).toBe("89abcdefXY");

      tail.add(Buffer.alloc(1024 * 1024, "z"));
      expect(tail.toString()).toBe("zzzzzzzzzz");
    });

    it("returns everything while under the limit", function () {
      var tail = guardServices.createTail(10);

      tail.add(Buffer.from("ab"));
      tail.add(Buffer.from("cd"));
      expect(tail.toString()).toBe("abcd");
    });
  });

  // These are set in the Dockerfile as system git config, which every git
  // process in the container reads, including the ones pushover starts.
  describe("git configuration", function () {
    it("runs index-pack and pack-objects on one thread", async function () {
      expect(await gitConfig("pack.threads")).toBe("1");
    });

    it("rejects pushes just under what the proxy allows", async function () {
      var megabyte = 1024 * 1024;
      var maxInputSize = Number(await gitConfig("receive.maxInputSize"));

      // the proxy accepts 2000M for /clients/git/end/ (proxy/config/blot-site.conf)
      expect(maxInputSize).toBeGreaterThan(1800 * megabyte);
      expect(maxInputSize).toBeLessThan(2000 * megabyte);
    });
  });
});
