describe("git store: pushes", function () {
  // A blog on the git client with a clone, a memory store per blog, and the
  // store's log lines kept
  require("clients/git/tests/setup")({ clone: false, client: true, lines: true });

  var Client = require("clients/git/tests/setup/client");
  var config = require("config");
  var crypto = require("crypto");
  var http = require("http");
  var path = require("path");
  var context = require("clients/git/served/context");
  var { PUSH_CACHE_SHARE } = require("clients/git/served/receive");
  var { manifest } = require("clients/git/store");

  function store(ctx) {
    return ctx.stores[ctx.blog.id];
  }

  async function lineMatching(ctx, pattern) {
    for (var i = 0; i < 100; i++) {
      var found = ctx.storeLines().filter(function (line) {
        return pattern.test(line);
      });
      if (found.length) return found;
      await new Promise(function (resolve) {
        setTimeout(resolve, 20);
      });
    }

    throw new Error("No log line matched " + pattern + "\n" + ctx.storeLines().join("\n"));
  }

  function request(ctx, method, suffix, options) {
    options = options || {};

    var parsed = new URL(ctx.repoUrl);
    var auth = Buffer.from(decodeURIComponent(parsed.username) + ":" + decodeURIComponent(parsed.password)).toString("base64");

    return new Promise(function (resolve, reject) {
      var req = http.request(
        {
          method: method,
          hostname: "127.0.0.1",
          port: ctx.server.port,
          path: "/clients/git/end/" + ctx.blog.handle + ".git" + suffix,
          headers: Object.assign({ Authorization: "Basic " + auth }, options.headers),
        },
        function (res) {
          var chunks = [];
          res.on("data", function (chunk) {
            chunks.push(chunk);
          });
          res.on("end", function () {
            resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("latin1") });
          });
        }
      );

      req.on("error", reject);
      req.end(options.body);
    });
  }

  it("takes a push into the store", async function () {
    await this.local.writeAndPush("/a.txt", "A");

    var before = await manifest.read(store(this));

    await this.local.commitFiles({ "/b.txt": "B" });
    await this.local.git(["tag", "-a", "v1", "-m", "A tag"]);
    // --progress: git sends "quiet" when its stderr is not a terminal, as
    // here, and a quiet client is sent no progress; a user at a terminal is
    var pushed = await this.local.push(["--progress", "origin", "master", "--tags"]);

    expect(pushed.stderr).toContain("Saving to Blot...");

    var head = await this.local.head();
    var current = await manifest.read(store(this));

    expect(current.seq).toBeGreaterThan(before.seq);
    expect(current.refs["refs/heads/master"]).toBe(head);
    expect(current.refs["refs/tags/v1"]).toBeDefined();
    expect(current.peeled[current.refs["refs/tags/v1"]]).toBe(head);

    // What is served now is the push
    expect(await this.local.remoteHead("master")).toBe(head);
    var clone = await Client.clone({ url: this.repoUrl, directory: path.join(this.tmp, "after-push") });
    expect(await clone.head()).toBe(head);
    expect((await clone.try(["fsck", "--strict"])).code).toBe(0);

    expect((await lineMatching(this, / op=push outcome=ok /))[0]).toMatch(new RegExp("blog=" + this.blog.id + " op=push outcome=ok ms=\\d+ bytesUp=\\d+ "));

  });

  it("refuses a symbolic link on master with Blot's message, and moves nothing", async function () {
    await this.local.writeAndPush("/a.txt", "A");

    var before = await manifest.read(store(this));

    require("fs").symlinkSync("a.txt", this.local.path("/link"));
    await this.local.commit("A link");

    var pushed = await this.local.tryPush();

    expect(pushed.code).not.toBe(0);
    expect(pushed.stderr).toContain("Git blogs support regular files only (no symbolic links or submodules)");
    expect((await manifest.read(store(this))).seq).toBe(before.seq);

    // The follow-up was never armed, or was taken back
    await this.local.waitForSync({ timeout: 10 * 1000 });
    await lineMatching(this, / op=push outcome=refused /);
  });

  it("refuses another branch, and deleting master", async function () {
    await this.local.writeAndPush("/a.txt", "A");

    var before = await manifest.read(store(this));

    await this.local.git(["checkout", "-q", "-b", "other"]);
    await this.local.commitFiles({ "/c.txt": "C" });

    var branch = await this.local.tryPush(["origin", "other"]);
    expect(branch.code).not.toBe(0);
    expect(branch.stderr).toContain("only the master branch is allowed");

    var deletion = await this.local.tryPush(["origin", ":master"]);
    expect(deletion.code).not.toBe(0);
    expect(deletion.stderr).toContain("master cannot be deleted");

    expect((await manifest.read(store(this))).seq).toBe(before.seq);
  });

  it("refuses a push over the limit, with the size, and gives the cache its room back", async function () {
    await this.local.writeAndPush("/a.txt", "A");

    // A small cache, once the repository is set up (an import into a cache
    // this small would not fit): the limit is the share of it
    config.git_store.cache_bytes = 4 * 1024 * 1024;
    context._reset();

    var limit = Math.floor(config.git_store.cache_bytes * PUSH_CACHE_SHARE);
    var before = await manifest.read(store(this));

    await this.local.commitFiles({ "/big.bin": crypto.randomBytes(limit + 1024 * 1024) });
    var pushed = await this.local.tryPush();

    expect(pushed.code).not.toBe(0);
    expect(pushed.stderr).toContain("this push is larger than Blot accepts (" + limit / (1024 * 1024) + " MiB)");
    expect((await manifest.read(store(this))).seq).toBe(before.seq);
    expect(context.cache().stats().reservedBytes).toBe(0);
  });

  it("takes a push whose changed tree names a .gitattributes the push does not carry", async function () {
    await this.local.commitFiles({ "/.gitattributes": "*.md text\n", "/.gitmodules": "", "/a.txt": "A" });
    await this.local.push();

    // The root tree changes, so it is in the pack; the .gitattributes and
    // .gitmodules blobs it names are not, being in the store already
    await this.local.commitFiles({ "/b.txt": "B" });
    var pushed = await this.local.tryPush();

    expect(pushed.code).toBe(0);
    expect((await manifest.read(store(this))).refs["refs/heads/master"]).toBe(await this.local.head());

    // The push's sync must not outlive the spec, whose teardown removes the
    // blog under it
    await this.local.waitForSync();
  });

  it("says another change is being applied when the ref lock stays taken", async function () {
    await this.local.writeAndPush("/a.txt", "A");

    var before = await manifest.read(store(this));
    var release = await require("clients/git/repo").holdRefLock(this.blog.id);

    try {
      await this.local.commitFiles({ "/b.txt": "B" });
      var pushed = await this.local.tryPush();

      expect(pushed.code).not.toBe(0);
      expect(pushed.stderr).toContain("another change to this repository is being applied; please try again in a few seconds");
      expect((await manifest.read(store(this))).seq).toBe(before.seq);
    } finally {
      await release();
    }

    // And with the lock free again, the same push lands
    expect((await this.local.tryPush()).code).toBe(0);
    await this.local.waitForSync();
  });

  it("ends a gzipped push whose client goes away part way through", async function () {
    await this.local.writeAndPush("/a.txt", "A");

    var ctx = this;
    var pushesBefore = this.storeLines("push").length;
    var zlib = require("zlib");
    var old = (await manifest.read(store(this))).refs["refs/heads/master"];
    var line = old + " " + "1".repeat(40) + " refs/heads/master\0report-status\n";
    var pkt = (line.length + 4).toString(16).padStart(4, "0") + line + "0000";

    var parsed = new URL(ctx.repoUrl);
    var auth = Buffer.from(decodeURIComponent(parsed.username) + ":" + decodeURIComponent(parsed.password)).toString("base64");

    // The commands and the start of a pack, gzipped and flushed so the server
    // can read them, then the connection is dropped with the body unfinished
    await new Promise(function (resolve) {
      var req = http.request({
        method: "POST",
        hostname: "127.0.0.1",
        port: ctx.server.port,
        path: "/clients/git/end/" + ctx.blog.handle + ".git/git-receive-pack",
        headers: {
          Authorization: "Basic " + auth,
          "Content-Type": "application/x-git-receive-pack-request",
          "Content-Encoding": "gzip",
          "Transfer-Encoding": "chunked",
        },
      });
      req.on("error", function () {});
      var gzip = zlib.createGzip();
      gzip.on("data", function (chunk) {
        req.write(chunk);
      });
      gzip.write(Buffer.concat([Buffer.from(pkt), Buffer.from("PACK"), Buffer.from([0, 0, 0, 2, 0, 0, 0, 5])]));
      gzip.flush(zlib.constants.Z_SYNC_FLUSH, function () {
        setTimeout(function () {
          req.destroy();
          resolve();
        }, 200);
      });
    });

    // The receive ends (and logs) rather than waiting on the decoder for ever
    for (var i = 0; i < 100 && this.storeLines("push").length <= pushesBefore; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    var lines = this.storeLines("push");
    expect(lines.length).toBeGreaterThan(pushesBefore);
    expect(lines[lines.length - 1]).not.toContain("outcome=ok");
  });

  it("answers git's 0000 probe and a body which is not git", async function () {
    await this.local.writeAndPush("/a.txt", "A");

    var probe = await request(this, "POST", "/git-receive-pack", {
      body: "0000",
      headers: { "Content-Type": "application/x-git-receive-pack-request" },
    });
    expect(probe.status).toBe(200);
    expect(probe.body).toBe("");

    var bad = await request(this, "POST", "/git-receive-pack", {
      body: "not git",
      headers: { "Content-Type": "application/x-git-receive-pack-request" },
    });
    expect(bad.status).toBe(400);
  });

  it("takes a push from a second clone after the first, and refuses a stale one", async function () {
    await this.local.writeAndPush("/a.txt", "A");

    var other = await this.local.cloneAgain();

    await this.local.writeAndPush("/b.txt", "B");

    await other.commitFiles({ "/c.txt": "C" });
    var stale = await other.tryPush();
    expect(stale.code).not.toBe(0);
    expect((await manifest.read(store(this))).refs["refs/heads/master"]).toBe(await this.local.head());

    await other.git(["pull", "--no-rebase", "--no-edit", "origin", "master"]);
    await other.push();
    expect((await manifest.read(store(this))).refs["refs/heads/master"]).toBe(await other.head());
  });

  it("accepts a force push to master", async function () {
    await this.local.writeAndPush("/a.txt", "A");

    await this.local.git(["checkout", "--quiet", "--orphan", "rewritten"]);
    await this.local.git(["rm", "-r", "--force", "--quiet", "."]);
    await this.local.commitFiles({ "/new.txt": "New history" });
    await this.local.push(["--force", "origin", "rewritten:master"]);

    expect((await manifest.read(store(this))).refs["refs/heads/master"]).toBe(await this.local.head());
  });

  it("creates and deletes tags", async function () {
    await this.local.writeAndPush("/a.txt", "A");

    await this.local.git(["tag", "light"]);
    await this.local.push(["origin", "light"]);
    expect((await manifest.read(store(this))).refs["refs/tags/light"]).toBe(await this.local.head());

    await this.local.push(["origin", ":refs/tags/light"]);
    expect((await manifest.read(store(this))).refs["refs/tags/light"]).toBeUndefined();
  });

  ["refs/notes/commits", "refs/remotes/origin/master", "refs/heads/master.lock"].forEach(function (ref) {
    it("refuses the ref " + ref, async function () {
      await this.local.writeAndPush("/a.txt", "A");

      var before = await manifest.read(store(this));
      var pushed = await this.local.tryPush(["origin", "master:" + ref]);

      expect(pushed.code).not.toBe(0);
      expect((await manifest.read(store(this))).seq).toBe(before.seq);
    });
  });
});
