// The receive side of the git client's HTTP endpoint (receivePack.js), checked
// with a real git client and with raw requests against a bare repository. The
// hooks the rest of Blot supplies (the ref lock, the follow-up sync) are
// stand-ins here, so these specs do not need a blog; the same pushes through
// the whole client are in push-policy.js and the specs around it.
describe("git client receive-pack", function () {
  var fs = require("fs-extra");
  var os = require("os");
  var http = require("http");
  var path = require("path");
  var zlib = require("zlib");
  var crypto = require("crypto");
  var childProcess = require("child_process");
  var smartHttp = require("clients/git/smartHttp");
  var receivePack = require("clients/git/receivePack");

  var ZERO = new Array(41).join("0");
  var pkt = receivePack.pktLine;

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function environment() {
    return Object.assign({}, process.env, {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
      GIT_AUTHOR_NAME: "Blot Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Blot Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    });
  }

  // Runs git, resolving { code, stdout, stderr } (stdout is a Buffer)
  function git(args, cwd, input) {
    return new Promise(function (resolve, reject) {
      var child = childProcess.spawn("git", args, { cwd: cwd, env: environment() });
      var out = [];
      var err = [];

      child.stdout.on("data", function (chunk) {
        out.push(chunk);
      });
      child.stderr.on("data", function (chunk) {
        err.push(chunk);
      });
      child.on("error", reject);
      child.on("close", function (code) {
        resolve({
          code: code,
          stdout: Buffer.concat(out),
          stderr: Buffer.concat(err).toString(),
        });
      });
      child.stdin.on("error", function () {});
      child.stdin.end(input || "");
    });
  }

  async function gitOK(args, cwd, input) {
    var result = await git(args, cwd, input);

    if (result.code !== 0) throw new Error("git " + args.join(" ") + ": " + result.stderr);

    return result.stdout.toString().trim();
  }

  // A bare repository served by smartHttp.js with hooks we control
  async function start(overrides) {
    var root = await fs.mkdtemp(path.join(os.tmpdir(), "blot-receive-"));
    var directory = path.join(root, "r.git");
    var ctx = {
      root: root,
      directory: directory,
      events: [],
      locked: false,
      requests: [],
    };

    await gitOK(["init", "--quiet", "--bare", "--initial-branch=master", directory]);

    ctx.hooks = Object.assign(
      {
        lock: function () {
          if (ctx.locked) {
            var err = new Error("held");
            err.code = "ELOCKED";
            return Promise.reject(err);
          }
          ctx.locked = true;
          return Promise.resolve(function () {
            ctx.locked = false;
          });
        },
        prepare: function (master) {
          ctx.events.push("prepare");
          return Promise.resolve(master.new);
        },
        accepted: function (master, prepared) {
          ctx.events.push("accepted");
          ctx.accepted = (ctx.accepted || []).concat([{ master: master, prepared: prepared }]);
        },
        abandoned: function () {
          ctx.events.push("abandoned");
        },
        limits: { maxInputSize: 0, strict: false },
      },
      overrides
    );

    ctx.server = http.createServer(function (req, res) {
      ctx.requests.push(req);
      req.gitHandle = "r";
      smartHttp.handle(req, res, directory, ctx.hooks);
    });

    await new Promise(function (resolve) {
      ctx.server.listen(0, "127.0.0.1", resolve);
    });

    ctx.port = ctx.server.address().port;
    ctx.url = "http://127.0.0.1:" + ctx.port + "/r.git";

    // A clone to commit in and push from
    ctx.clone = async function (name) {
      var directory = path.join(root, name || "clone-" + crypto.randomBytes(3).toString("hex"));

      await gitOK(["init", "--quiet", "--initial-branch=master", directory]);
      await gitOK(["remote", "add", "origin", ctx.url], directory);

      return directory;
    };

    ctx.commit = async function (directory, files, message) {
      for (var file of Object.keys(files)) {
        await fs.outputFile(path.join(directory, file), files[file]);
      }

      await gitOK(["add", "--all"], directory);
      await gitOK(["commit", "--quiet", "--message", message || "Commit"], directory);

      return gitOK(["rev-parse", "HEAD"], directory);
    };

    ctx.push = function (directory, args) {
      return git(["push"].concat(args || ["origin", "master"]), directory);
    };

    ctx.ref = async function (ref) {
      var result = await git(["rev-parse", "--verify", "--quiet", ref], directory);

      return result.code === 0 ? result.stdout.toString().trim() : null;
    };

    ctx.quarantines = async function () {
      var entries = await fs.readdir(path.join(directory, "objects"));

      return entries.filter(function (name) {
        return name.indexOf("tmp_objdir-incoming-") === 0;
      });
    };

    ctx.request = function (method, url, body, headers) {
      return new Promise(function (resolve, reject) {
        var req = http.request(
          {
            method: method,
            hostname: "127.0.0.1",
            port: ctx.port,
            path: "/r.git" + url,
            headers: headers || {},
          },
          function (res) {
            var chunks = [];

            res.on("data", function (chunk) {
              chunks.push(chunk);
            });
            res.on("end", function () {
              resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
            });
          }
        );

        req.on("error", reject);
        req.end(body);
      });
    };

    ctx.stop = async function () {
      await new Promise(function (resolve) {
        ctx.server.close(resolve);
        ctx.server.closeAllConnections();
      });
      await fs.remove(root);
    };

    return ctx;
  }

  // The body of a push: its commands (the first carries the capabilities),
  // a flush, and the pack
  function pushBody(commands, capabilities, pack) {
    var lines = commands.map(function (command, index) {
      return pkt(
        command.old + " " + command.new + " " + command.ref + (index === 0 ? "\0" + capabilities : "") + "\n"
      );
    });

    return Buffer.concat(lines.concat([Buffer.from("0000"), pack || Buffer.alloc(0)]));
  }

  // The pkt-lines of a response as text
  function packets(buffer) {
    var lines = [];
    var offset = 0;

    while (offset < buffer.length) {
      var length = parseInt(buffer.toString("latin1", offset, offset + 4), 16);

      if (length === 0) {
        lines.push("0000");
        offset += 4;
      } else {
        lines.push(buffer.toString("utf8", offset + 4, offset + length));
        offset += length;
      }
    }

    return lines;
  }

  // What a side-band-64k response says: { report: [lines], messages: [lines] }
  function sidebandResponse(buffer) {
    var report = [];
    var messages = [];

    packets(buffer).forEach(function (line) {
      if (line === "0000") return;
      if (line[0] === "\u0001") report = report.concat(packets(Buffer.from(line.slice(1))));
      if (line[0] === "\u0002") messages.push(line.slice(1).trim());
    });

    return { report: report, messages: messages };
  }

  // A pack with only the objects given (no others they need)
  function packOf(directory, objects) {
    return git(["pack-objects", "--stdout"], directory, objects.join("\n") + "\n").then(function (result) {
      return result.stdout;
    });
  }

  var ctx;

  beforeEach(async function () {
    spyOn(console, "log");
    ctx = await start();
  });

  afterEach(async function () {
    await ctx.stop();
  });

  describe("the advertisement", function () {
    it("has capabilities^{} for an empty repository, and only what is implemented", async function () {
      var response = await ctx.request("GET", "/info/refs?service=git-receive-pack");
      var lines = packets(response.body);

      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe("application/x-git-receive-pack-advertisement");
      expect(response.headers["cache-control"]).toBe("no-cache, max-age=0, must-revalidate");
      expect(lines[0]).toBe("# service=git-receive-pack\n");
      expect(lines[1]).toBe("0000");
      expect(lines[2]).toMatch(/^0{40} capabilities\^\{\}\0/);
      expect(lines[3]).toBe("0000");

      var capabilities = lines[2].split("\0")[1].trim().split(" ");

      expect(capabilities).toEqual(receivePack.CAPABILITIES);

      ["atomic", "push-options", "report-status-v2", "push-cert"].forEach(function (name) {
        expect(capabilities).not.toContain(name);
      });
    });

    it("lists refs sorted, with the capabilities on the first and no HEAD", async function () {
      var clone = await ctx.clone();
      var first = await ctx.commit(clone, { "a.txt": "A" });

      await gitOK(["tag", "v1"], clone);
      await gitOK(["tag", "-a", "-m", "annotated", "v2"], clone);
      expect((await ctx.push(clone, ["origin", "master", "v1", "v2"])).code).toBe(0);

      var lines = packets((await ctx.request("GET", "/info/refs?service=git-receive-pack")).body).slice(2, -1);
      var names = lines.map(function (line) {
        return line.split("\0")[0].trim().slice(41);
      });

      expect(names).toEqual(["refs/heads/master", "refs/tags/v1", "refs/tags/v2"]);
      expect(lines[0]).toContain("\0report-status");
      expect(lines[1]).not.toContain("\0");
      expect(lines[0].slice(0, 40)).toBe(first);
    });

    it("is a 404 for a missing repository", async function () {
      await fs.remove(ctx.directory);

      var response = await ctx.request("GET", "/info/refs?service=git-receive-pack");

      expect(response.status).toBe(404);
      expect(response.body.toString()).toBe("repository not found");
    });
  });

  describe("a push", function () {
    it("creates master in an empty repository, with the quarantine gone and one pack", async function () {
      var clone = await ctx.clone();
      var head = await ctx.commit(clone, { "a.txt": "A" });
      var pushed = await ctx.push(clone);

      expect(pushed.code).toBe(0);
      expect(await ctx.ref("master")).toBe(head);
      expect(await ctx.quarantines()).toEqual([]);
      expect(await fs.readdir(path.join(ctx.directory, "objects", "pack"))).toContain(
        jasmine.stringMatching(/\.idx$/)
      );
      expect(ctx.accepted.length).toBe(1);
      expect(ctx.accepted[0].master).toEqual({ old: ZERO, new: head, ref: "refs/heads/master" });
      expect(ctx.accepted[0].prepared).toBe(head);

      // The repository is whole
      expect(await git(["fsck", "--strict"], ctx.directory)).toEqual(
        jasmine.objectContaining({ code: 0 })
      );
    });

    it("writes the follow-up before the refs move, and tells the sync after", async function () {
      var clone = await ctx.clone();
      var observed;

      await ctx.commit(clone, { "a.txt": "A" });

      ctx.hooks.prepare = async function () {
        observed = await ctx.ref("master");
        ctx.events.push("prepare");
      };

      await ctx.push(clone);

      // The sync is told as soon as the refs have moved, not when the
      // response has been read
      expect(observed).toBe(null);
      expect(ctx.events).toEqual(["prepare", "accepted"]);
    });

    it("fails the push, and moves nothing, if the follow-up can't be written", async function () {
      var clone = await ctx.clone();

      await ctx.commit(clone, { "a.txt": "A" });

      ctx.hooks.prepare = function () {
        return Promise.reject(new Error("Redis is down"));
      };

      var pushed = await ctx.push(clone);

      expect(pushed.code).not.toBe(0);
      expect(pushed.stderr).toContain("remote rejected");
      expect(pushed.stderr).toContain("could not record the push");
      expect(await ctx.ref("master")).toBe(null);
      expect(ctx.accepted).toBeUndefined();
      expect(ctx.locked).toBe(false);
      expect(await ctx.quarantines()).toEqual([]);
    });

    it("tells the sync about a push even if the client has gone by the time it is told", async function () {
      var clone = await ctx.clone();
      var head = await ctx.commit(clone, { "a.txt": "A" });

      // Raw, so that we can hang up the moment the response starts
      var body = Buffer.concat([
        pkt(ZERO + " " + head + " refs/heads/master\0report-status side-band-64k\n"),
        Buffer.from("0000"),
        await packOf(clone, [head, await gitOK(["rev-parse", "HEAD^{tree}"], clone), await gitOK(["rev-parse", "HEAD:a.txt"], clone)]),
      ]);

      await new Promise(function (resolve) {
        var req = http.request(
          { method: "POST", hostname: "127.0.0.1", port: ctx.port, path: "/r.git/git-receive-pack" },
          function (res) {
            res.destroy();
            resolve();
          }
        );

        req.on("error", resolve);
        req.end(body);
      });

      await sleep(300);

      expect(await ctx.ref("master")).toBe(head);
      expect(ctx.accepted.length).toBe(1);
    });

    it("logs the exit line, the client's agent and no stderr", async function () {
      var clone = await ctx.clone();

      await ctx.commit(clone, { "a.txt": "A" });
      await ctx.push(clone);

      var lines = console.log.calls.allArgs().map(function (args) {
        return args.join(" ");
      });
      var exit = lines.filter(function (line) {
        return line.indexOf(" Git: receive-pack ") > -1;
      });
      var agent = lines.filter(function (line) {
        return line.indexOf(" Git: push-client ") > -1;
      });

      expect(exit.length).toBe(1);
      expect(exit[0]).toMatch(/ Git: receive-pack r exit=0 duration=\d+\.\d{3}s rx=[1-9]\d* tx=\d+$/);
      expect(agent.length).toBe(1);
      expect(agent[0]).toMatch(/ agent="git\/[^"]+"$/);
    });

    it("accepts a force push to master", async function () {
      var clone = await ctx.clone();

      await ctx.commit(clone, { "a.txt": "A" });
      await ctx.commit(clone, { "a.txt": "B" });
      await ctx.push(clone);

      await gitOK(["reset", "--hard", "--quiet", "HEAD~1"], clone);

      var replaced = await ctx.commit(clone, { "a.txt": "C" });

      expect((await ctx.push(clone)).code).not.toBe(0);
      expect((await ctx.push(clone, ["--force", "origin", "master"])).code).toBe(0);
      expect(await ctx.ref("master")).toBe(replaced);
      expect(ctx.accepted.length).toBe(2);
    });

    it("accepts a thin pack against an object the repository already has", async function () {
      var clone = await ctx.clone();
      var lines = [];

      for (var i = 0; i < 4000; i++) lines.push("line " + i + " " + crypto.randomBytes(6).toString("hex"));

      await ctx.commit(clone, { "big.txt": lines.join("\n") });
      await ctx.push(clone);

      lines[2000] = "changed";

      var head = await ctx.commit(clone, { "big.txt": lines.join("\n") });
      var pushed = await ctx.push(clone, ["--thin", "origin", "master"]);

      expect(pushed.code).toBe(0);
      expect(await ctx.ref("master")).toBe(head);
      expect((await git(["fsck", "--strict"], ctx.directory)).code).toBe(0);
    });

    it("accepts a push from a shallow clone", async function () {
      var clone = await ctx.clone();

      await ctx.commit(clone, { "a.txt": "A" });
      await ctx.commit(clone, { "a.txt": "B" });
      await ctx.push(clone);

      var shallow = path.join(ctx.root, "shallow");

      await gitOK(["clone", "--quiet", "--depth", "1", ctx.url, shallow]);

      var head = await ctx.commit(shallow, { "b.txt": "B" });

      expect((await ctx.push(shallow)).code).toBe(0);
      expect(await ctx.ref("master")).toBe(head);
    });

    it("creates and deletes tags", async function () {
      var clone = await ctx.clone();
      var head = await ctx.commit(clone, { "a.txt": "A" });

      await ctx.push(clone);
      await gitOK(["tag", "v1"], clone);
      await gitOK(["tag", "-a", "-m", "release", "v2"], clone);

      expect((await ctx.push(clone, ["origin", "v1", "v2"])).code).toBe(0);
      expect(await ctx.ref("refs/tags/v1")).toBe(head);
      expect(await ctx.ref("refs/tags/v2")).not.toBe(null);

      // Tags don't start a sync
      expect(ctx.accepted.length).toBe(1);

      expect((await ctx.push(clone, ["origin", ":refs/tags/v1"])).code).toBe(0);
      expect(await ctx.ref("refs/tags/v1")).toBe(null);
      expect(await ctx.ref("refs/tags/v2")).not.toBe(null);
      expect(ctx.accepted.length).toBe(1);
    });

    it("refuses to delete master, with a message", async function () {
      var clone = await ctx.clone();
      var head = await ctx.commit(clone, { "a.txt": "A" });

      await ctx.push(clone);

      var refused = await ctx.push(clone, ["origin", ":master"]);

      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain("remote: refs/heads/master: Push rejected: master cannot be deleted.");
      expect(refused.stderr).toContain("[remote rejected]");
      expect(await ctx.ref("master")).toBe(head);
      expect(ctx.accepted.length).toBe(1);
    });

    ["master sneaky", "sneaky master"].forEach(function (order) {
      it("refuses the whole push if a branch comes with master (" + order + ")", async function () {
        var clone = await ctx.clone();

        await ctx.commit(clone, { "a.txt": "A" });
        await ctx.push(clone);
        await ctx.commit(clone, { "a.txt": "B" });
        await gitOK(["branch", "sneaky"], clone);

        var refused = await ctx.push(clone, ["origin"].concat(order.split(" ")));

        expect(refused.code).not.toBe(0);
        expect(refused.stderr).toContain("only the master branch is allowed");
        expect(await ctx.ref("sneaky")).toBe(null);
        expect(await ctx.ref("master")).not.toBe(await gitOK(["rev-parse", "HEAD"], clone));
        expect(ctx.accepted.length).toBe(1);
        expect(ctx.events.filter((event) => event === "prepare").length).toBe(1);
        expect(await ctx.quarantines()).toEqual([]);
      });
    });

    it("refuses a symbolic link, with the reason on the client, and moves nothing", async function () {
      var clone = await ctx.clone();
      var good = await ctx.commit(clone, { "a.txt": "A" });

      await ctx.push(clone);
      await fs.symlink("a.txt", path.join(clone, "link.txt"));
      await gitOK(["add", "--all"], clone);
      await gitOK(["commit", "--quiet", "--message", "Link"], clone);

      var refused = await ctx.push(clone);

      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain("remote: refs/heads/master: Git blogs support regular files only");
      expect(await ctx.ref("master")).toBe(good);
      expect(ctx.accepted.length).toBe(1);
    });

    it("refuses a submodule", async function () {
      var clone = await ctx.clone();
      var good = await ctx.commit(clone, { "a.txt": "A" });

      await ctx.push(clone);
      await gitOK(["update-index", "--add", "--cacheinfo", "160000," + good + ",vendor/sub"], clone);
      await gitOK(["commit", "--quiet", "--message", "Submodule"], clone);

      var refused = await ctx.push(clone);

      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain("regular files only");
      expect(await ctx.ref("master")).toBe(good);
    });

    it("refuses a pack which leaves out an object it needs", async function () {
      var clone = await ctx.clone();
      var head = await ctx.commit(clone, { "a.txt": "A" });
      var body = pushBody(
        [{ old: ZERO, new: head, ref: "refs/heads/master" }],
        "report-status",
        await packOf(clone, [head])
      );
      var response = await ctx.request("POST", "/git-receive-pack", body);
      var lines = packets(response.body);

      expect(response.status).toBe(200);
      expect(lines).toEqual(["unpack ok\n", "ng refs/heads/master missing necessary objects\n", "0000"]);
      expect(await ctx.ref("master")).toBe(null);
      expect(await ctx.quarantines()).toEqual([]);
      expect(ctx.events).toEqual([]);
    });

    it("refuses a ref which moved while the pack was arriving, and doesn't sync", async function () {
      var clone = await ctx.clone();
      var other = await ctx.clone();

      await ctx.commit(clone, { "a.txt": "A" });
      await ctx.push(clone);
      await gitOK(["pull", "--quiet", "origin", "master"], other);

      var ours = await ctx.commit(clone, { "a.txt": "ours" });
      var theirs = await ctx.commit(other, { "a.txt": "theirs" });

      // Theirs lands between the checks and our update, as a push which
      // started later but finished earlier would
      ctx.hooks.lock = async function () {
        ctx.hooks.lock = undefined;
        expect((await ctx.push(other)).code).toBe(0);
        return function () {};
      };

      var refused = await ctx.push(clone);

      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain("the ref moved while you were pushing");
      expect(await ctx.ref("master")).toBe(theirs);
      expect(ctx.accepted.length).toBe(2);
      expect(ours).toBeTruthy();
    });

    it("refuses an update whose base moves after the check, and takes the follow-up back", async function () {
      var clone = await ctx.clone();
      var head = await ctx.commit(clone, { "a.txt": "A" });

      await ctx.push(clone);
      await ctx.commit(clone, { "a.txt": "B" });

      // Master moves in the gap between the check and the update, which the
      // lock exists to prevent but update-ref's old value would catch too
      ctx.hooks.prepare = async function () {
        ctx.events.push("prepare");

        var tree = await gitOK(["hash-object", "-t", "tree", "-w", "--stdin"], ctx.directory, "");
        var raced = await gitOK(["commit-tree", "-m", "raced", tree], ctx.directory);

        await gitOK(["update-ref", "refs/heads/master", raced], ctx.directory);
      };

      var refused = await ctx.push(clone);

      expect(refused.code).not.toBe(0);
      expect(ctx.events).toContain("abandoned");
      expect(ctx.accepted.length).toBe(1);
      expect(await ctx.ref("master")).not.toBe(head);
      expect(ctx.locked).toBe(false);
    });

    it("tells a second push it can't have the lock, without corrupting anything", async function () {
      var clone = await ctx.clone();
      var other = await ctx.clone();

      await ctx.commit(clone, { "a.txt": "A" });
      await ctx.push(clone);
      await gitOK(["pull", "--quiet", "origin", "master"], other);

      await ctx.commit(clone, { "a.txt": "first" });
      var second = await ctx.commit(other, { "b.txt": "second" });
      var release;
      var inside = new Promise(function (resolve) {
        ctx.hooks.prepare = function () {
          resolve();
          return new Promise(function (done) {
            release = done;
          });
        };
      });

      var first = ctx.push(clone);

      await inside;

      var refused = await ctx.push(other);

      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain("being applied; please try again");

      release("ok");

      expect((await first).code).toBe(0);
      expect(await ctx.ref("master")).not.toBe(second);
      expect((await git(["fsck", "--strict"], ctx.directory)).code).toBe(0);
      expect(ctx.locked).toBe(false);
    });

    it("doesn't hold the lock while a pack is arriving", async function () {
      var clone = await ctx.clone();
      var head = await ctx.commit(clone, { "a.txt": "A" });
      var slow = http.request({
        method: "POST",
        hostname: "127.0.0.1",
        port: ctx.port,
        path: "/r.git/git-receive-pack",
        headers: { "content-length": 1024 * 1024 },
      });

      slow.on("error", function () {});
      slow.write(pushBody([{ old: ZERO, new: head, ref: "refs/heads/master" }], "report-status"));
      slow.write(Buffer.from("PACK\0\0\0\2\0\0\0\u0001"));

      await sleep(300);

      expect(ctx.locked).toBe(false);
      expect(await ctx.quarantines()).toEqual([jasmine.stringMatching(/^tmp_objdir-incoming-/)]);
      expect((await ctx.push(clone)).code).toBe(0);

      slow.destroy();
    });

    it("stops index-pack and removes the quarantine when the client goes away", async function () {
      var clone = await ctx.clone();
      var head = await ctx.commit(clone, { "a.txt": "A" });
      var req = http.request({
        method: "POST",
        hostname: "127.0.0.1",
        port: ctx.port,
        path: "/r.git/git-receive-pack",
        headers: { "content-length": 10 * 1024 * 1024 },
      });

      req.on("error", function () {});
      req.write(pushBody([{ old: ZERO, new: head, ref: "refs/heads/master" }], "report-status"));
      // A pack header which promises 256 objects, so index-pack waits for them
      req.write(Buffer.from("PACK\0\0\0\2\0\0\u0001\0"));

      var started = Date.now();

      while (!(await ctx.quarantines()).length && Date.now() - started < 5000) await sleep(50);

      expect((await ctx.quarantines()).length).toBe(1);

      req.destroy();

      var deadline = Date.now() + 10000;
      var processes;

      do {
        await sleep(100);
        processes = await new Promise(function (resolve) {
          childProcess.execFile("ps", ["-eo", "pid=,args="], function (err, stdout) {
            resolve(
              String(stdout)
                .split("\n")
                .filter(function (line) {
                  return /git[ -]index-pack/.test(line) && line.indexOf("--stdin") > -1;
                })
            );
          });
        });
      } while ((processes.length || (await ctx.quarantines()).length) && Date.now() < deadline);

      expect(processes).toEqual([]);
      expect(await ctx.quarantines()).toEqual([]);
      expect(await ctx.ref("master")).toBe(null);
      expect(ctx.events).toEqual([]);
    });

    it("refuses a push over the input limit, with a message", async function () {
      ctx.hooks.limits = { maxInputSize: 2 * 1024 * 1024, strict: false };

      var clone = await ctx.clone();

      await ctx.commit(clone, { "big.bin": crypto.randomBytes(5 * 1024 * 1024) });

      var refused = await ctx.push(clone);

      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain("the push is larger than the 2 MB Blot accepts");
      expect(await ctx.ref("master")).toBe(null);
      expect(await ctx.quarantines()).toEqual([]);
    });
  });

  describe("requests", function () {
    var caps = "report-status side-band-64k";

    it("answers git's 0000 probe with an empty result", async function () {
      var response = await ctx.request("POST", "/git-receive-pack", "0000");

      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe("application/x-git-receive-pack-result");
      expect(response.headers["cache-control"]).toBe("no-cache, max-age=0, must-revalidate");
      expect(response.body.length).toBe(0);
    });

    it("accepts a gzipped request", async function () {
      var clone = await ctx.clone();
      var head = await ctx.commit(clone, { "a.txt": "A" });

      await ctx.push(clone);
      await gitOK(["tag", "v1"], clone);
      await ctx.push(clone, ["origin", "v1"]);

      var body = zlib.gzipSync(pushBody([{ old: head, new: ZERO, ref: "refs/tags/v1" }], caps));
      var response = await ctx.request("POST", "/git-receive-pack", body, { "content-encoding": "gzip" });

      expect(response.status).toBe(200);
      expect(sidebandResponse(response.body).report).toEqual(["unpack ok\n", "ok refs/tags/v1\n", "0000"]);
      expect(await ctx.ref("refs/tags/v1")).toBe(null);
    });

    it("answers a corrupt gzip body with a 400", async function () {
      var response = await ctx.request("POST", "/git-receive-pack", Buffer.from("not gzip at all"), {
        "content-encoding": "gzip",
      });

      expect(response.status).toBe(400);
    });

    it("answers something that isn't git with a 400, and an empty body too", async function () {
      expect((await ctx.request("POST", "/git-receive-pack", "hello there")).status).toBe(400);
      expect((await ctx.request("POST", "/git-receive-pack", "")).status).toBe(400);
    });

    it("refuses commands with no pack", async function () {
      var clone = await ctx.clone();
      var head = await ctx.commit(clone, { "a.txt": "A" });
      var response = await ctx.request(
        "POST",
        "/git-receive-pack",
        pushBody([{ old: ZERO, new: head, ref: "refs/heads/master" }], "report-status")
      );

      expect(packets(response.body)).toEqual([
        "unpack eof before pack header was fully read\n",
        "ng refs/heads/master unpacker error\n",
        "0000",
      ]);
      expect(await ctx.ref("master")).toBe(null);
    });

    ["HEAD", "master", "refs/heads/../x", "refs/tags/a b", "refs/heads/x.lock", "refs/remotes/o/x", "refs/for/master"].forEach(
      function (ref) {
        it("refuses the ref " + ref, async function () {
          var clone = await ctx.clone();
          var head = await ctx.commit(clone, { "a.txt": "A" });
          var response = await ctx.request(
            "POST",
            "/git-receive-pack",
            pushBody([{ old: ZERO, new: head, ref: ref }], "report-status", await packOf(clone, [head]))
          );
          var lines = packets(response.body);

          expect(lines[0]).toBe("unpack ok\n");
          expect(lines[1]).toMatch(new RegExp("^ng " + ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " Push rejected"));
          expect(await ctx.ref("master")).toBe(null);
        });
      }
    );

    it("sends side-band messages only when asked", async function () {
      var clone = await ctx.clone();
      var head = await ctx.commit(clone, { "a.txt": "A" });
      var command = [{ old: ZERO, new: head, ref: "refs/heads/other" }];
      var plain = await ctx.request("POST", "/git-receive-pack", pushBody(command, "report-status", await packOf(clone, [head])));
      var banded = await ctx.request("POST", "/git-receive-pack", pushBody(command, caps, await packOf(clone, [head])));
      var silent = await ctx.request("POST", "/git-receive-pack", pushBody(command, "", await packOf(clone, [head])));

      expect(plain.body.toString()).not.toContain("\u0002");
      expect(sidebandResponse(banded.body).messages).toContain(
        "refs/heads/other: Push rejected: only the master branch is allowed. Please push to master or open a PR."
      );
      expect(silent.body.length).toBe(0);
    });
  });

  describe("everything else", function () {
    it("answers with the statuses pushover gave", async function () {
      var cases = [
        ["GET", "/info/refs", 400, "service parameter required"],
        ["GET", "/info/refs?service=git-nothing", 405, "service not available"],
        ["GET", "/HEAD", 200, "ref: refs/heads/master\n"],
        ["POST", "/git-nothing", 405, "service not available"],
        ["POST", "/git-receive-pack?x=1", 405, "service not available"],
        ["PUT", "/git-receive-pack", 405, "method not supported"],
        ["DELETE", "/info/refs", 405, "method not supported"],
        ["GET", "/git-receive-pack", 404, "not found"],
        ["POST", "/info/refs", 404, "not found"],
        ["GET", "/objects/info/packs", 404, "not found"],
      ];

      for (var testCase of cases) {
        var response = await ctx.request(testCase[0], testCase[1]);

        expect([testCase[0] + " " + testCase[1], response.status, response.body.toString()]).toEqual([
          testCase[0] + " " + testCase[1],
          testCase[2],
          testCase[3],
        ]);
      }
    });
  });
});
