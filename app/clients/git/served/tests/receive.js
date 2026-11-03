describe("git store served: pushes on the normal route", function () {
  // Shadow mode's set-up: a blog on the git client with a clone, and a memory
  // store per blog, shared with the served path through served/context.js
  var setup = require("clients/git/shadow/tests/setup");
  var Client = require("clients/git/tests/setup/client");
  var config = require("config");
  var crypto = require("crypto");
  var http = require("http");
  var path = require("path");
  var context = require("clients/git/served/context");
  var upkeep = require("clients/git/served/upkeep");
  var fallback = require("clients/git/served/fallback");
  var { PUSH_CACHE_SHARE } = require("clients/git/served/receive");
  var { manifest } = require("clients/git/store");

  setup();

  beforeEach(function () {
    var ctx = this;
    ctx.servedLines = [];
    console.log.and.callFake(function () {
      var line = Array.prototype.join.call(arguments, " ");
      if (line.indexOf("[git-store-shadow]") !== -1) ctx.lines.push(line);
      if (line.indexOf("[git-store-served]") !== -1) ctx.servedLines.push(line);
    });
  });

  afterEach(async function () {
    await fallback.idle(this.blog.id);
    await upkeep.idle(this.blog.id);
  });

  // Fills the store from EBS (serve off), then switches the blog on
  async function mirrorAndSwitch(ctx) {
    config.git_store.serve = "";
    await setup.expectMirrored(ctx);
    config.git_store.serve = String(ctx.blog.id);
  }

  function store(ctx) {
    return ctx.stores[ctx.blog.id];
  }

  async function lineMatching(ctx, pattern) {
    for (var i = 0; i < 100; i++) {
      var found = ctx.servedLines.filter(function (line) {
        return pattern.test(line);
      });
      if (found.length) return found;
      await new Promise(function (resolve) {
        setTimeout(resolve, 20);
      });
    }

    throw new Error("No log line matched " + pattern + "\n" + ctx.servedLines.join("\n"));
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

  it("takes a push into the store and leaves EBS alone", async function () {
    await this.local.writeAndPush("/a.txt", "A");
    await mirrorAndSwitch(this);

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

    // EBS catches up in the background (the fallback), not during the push
    await fallback.idle(this.blog.id);
    expect(setup.ebsRefs(this.gitDir)).toEqual(current.refs);

    // What the normal route now serves is the push
    expect(await this.local.remoteHead("master")).toBe(head);
    var clone = await Client.clone({ url: this.repoUrl, directory: path.join(this.tmp, "after-push") });
    expect(await clone.head()).toBe(head);
    expect((await clone.try(["fsck", "--strict"])).code).toBe(0);

    expect((await lineMatching(this, / op=push outcome=ok /))[0]).toMatch(new RegExp("blog=" + this.blog.id + " op=push outcome=ok ms=\\d+ bytesUp=\\d+ "));

    // Never shadowed
    expect(this.shadowLines("push").length).toBe(0);
  });

  it("refuses a symbolic link on master with Blot's message, and moves nothing", async function () {
    await this.local.writeAndPush("/a.txt", "A");
    await mirrorAndSwitch(this);

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

  it("refuses what EBS refuses: another branch, deleting master", async function () {
    await this.local.writeAndPush("/a.txt", "A");
    await mirrorAndSwitch(this);

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
    await mirrorAndSwitch(this);

    // A small cache, once the store is filled (an import into a cache this
    // small would not fit): the limit is the share of it
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

  it("answers git's 0000 probe and a body which is not git", async function () {
    await this.local.writeAndPush("/a.txt", "A");
    await mirrorAndSwitch(this);

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
    await mirrorAndSwitch(this);

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
});
