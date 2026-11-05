describe("git store served: the EBS fallback", function () {
  // Shadow mode's set-up: a blog on the git client with a clone, and a memory
  // store per blog, shared with the served path through served/context.js
  var setup = require("clients/git/shadow/tests/setup");
  var Client = require("clients/git/tests/setup/client");
  var config = require("config");
  var path = require("path");
  var repo = require("clients/git/repo");
  var fallback = require("clients/git/served/fallback");
  var upkeep = require("clients/git/served/upkeep");
  var maintenance = require("clients/git/shadow/maintenance");
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

  async function mirrorAndSwitch(ctx) {
    config.git_store.serve = "";
    await setup.expectMirrored(ctx);
    config.git_store.serve = String(ctx.blog.id);
  }

  async function storeRefs(ctx) {
    return (await manifest.read(ctx.stores[ctx.blog.id])).refs;
  }

  // EBS as git sees it, switched off
  async function expectEbsMatches(ctx) {
    expect(setup.ebsRefs(ctx.gitDir)).toEqual(await storeRefs(ctx));
    setup.git(ctx.gitDir, ["fsck", "--strict", "--no-dangling"]);
  }

  it("brings EBS up to a push into the store, and a clone from it after switching off is the same", async function () {
    await this.local.writeAndPush("/a.txt", "A");
    await mirrorAndSwitch(this);

    await this.local.commitFiles({ "/b.txt": "B", "/c/d.txt": "D" });
    await this.local.git(["tag", "-a", "v1", "-m", "A tag"]);
    await this.local.push(["origin", "master", "--tags"]);
    await fallback.idle(this.blog.id);

    await expectEbsMatches(this);
    expect(this.servedLines.filter((line) => / op=fallback outcome=ok /.test(line)).length).toBeGreaterThan(0);

    // The rollback: switched off, the blog is served from EBS again
    config.git_store.serve = "";
    var clone = await Client.clone({ url: this.repoUrl, directory: path.join(this.tmp, "after-rollback") });
    expect(await clone.head()).toBe(await this.local.head());
    expect((await clone.git(["tag", "--list"])).stdout.trim()).toBe("v1");
  });

  it("follows a force push and a deleted tag", async function () {
    await this.local.writeAndPush("/a.txt", "A");
    await this.local.git(["tag", "old"]);
    await this.local.push(["origin", "--tags"]);
    await mirrorAndSwitch(this);

    await this.local.writeAndPush("/b.txt", "B");
    await this.local.git(["reset", "--hard", "HEAD~1"]);
    await this.local.commitFiles({ "/other.txt": "Other" });
    await this.local.push(["--force", "origin", "master"]);
    await this.local.push(["origin", ":refs/tags/old"]);
    await fallback.idle(this.blog.id);

    await expectEbsMatches(this);
    expect(setup.ebsRefs(this.gitDir)["refs/tags/old"]).toBeUndefined();
  });

  it("says when EBS is already current, and never copies an empty store over EBS", async function () {
    await this.local.writeAndPush("/a.txt", "A");
    await mirrorAndSwitch(this);

    expect((await fallback.run(this.blog.id)).outcome).toBe("current");

    // A blog switched on before its store was filled
    var ebs = setup.ebsRefs(this.gitDir);
    this.stores[this.blog.id] = require("clients/git/store").createMemoryStore();
    require("clients/git/served/context")._reset();

    var result = await fallback.run(this.blog.id);
    expect(result.outcome).toBe("skipped");
    expect(setup.ebsRefs(this.gitDir)).toEqual(ebs);
  });

  it("leaves EBS alone if its refs move while the pack is fetched", async function () {
    await this.local.writeAndPush("/a.txt", "A");
    await mirrorAndSwitch(this);

    // A push into the store whose fallback is held back
    spyOn(fallback, "request").and.returnValue(Promise.resolve());
    await this.local.writeAndPush("/b.txt", "B");
    fallback.request.and.callThrough();

    var gitDir = this.gitDir;
    var master = setup.ebsRefs(gitDir)["refs/heads/master"];
    var hold = repo.holdRefLock;

    // Something else moves EBS just before the fallback takes the lock
    spyOn(repo, "holdRefLock").and.callFake(function (blogID) {
      setup.git(gitDir, ["update-ref", "refs/tags/sneaky", master]);
      return hold(blogID);
    });

    var result = await fallback.run(this.blog.id);
    expect(result.outcome).toBe("moved");
    expect(setup.ebsRefs(gitDir)["refs/heads/master"]).toBe(master);

    // The next one takes it from there (the sneaky tag is not the store's)
    repo.holdRefLock.and.callFake(hold);
    expect((await fallback.run(this.blog.id)).outcome).toBe("ok");
    expect(setup.ebsRefs(gitDir)["refs/heads/master"]).toBe((await storeRefs(this))["refs/heads/master"]);
    expect(setup.ebsRefs(gitDir)["refs/tags/sneaky"]).toBeUndefined();
  });

  it("lets the daily verifier catch EBS up for a switched blog, and report nothing", async function () {
    await this.local.writeAndPush("/a.txt", "A");
    await mirrorAndSwitch(this);

    spyOn(fallback, "request").and.returnValue(Promise.resolve());
    await this.local.writeAndPush("/b.txt", "B");
    fallback.request.and.callThrough();

    expect(setup.ebsRefs(this.gitDir)).not.toEqual(await storeRefs(this));

    var checked = await maintenance.verify(this.blog.id, { recheckDelayMs: 10 });

    expect(checked.findings).toEqual([]);
    await expectEbsMatches(this);
    expect(this.servedLines.filter((line) => / op=fallback outcome=ok .*reason=verify/.test(line)).length).toBe(1);
  });

  it("covers served blogs in the daily maintenance even when they are not shadowed", async function () {
    config.git_store.shadow = "";
    config.git_store.serve = String(this.blog.id);

    expect(maintenance.configured()).toBe(true);
    expect(await maintenance.gitBlogs()).toEqual([String(this.blog.id)]);
  });

  it("builds the request git's upload-pack would read, and unwraps the answer", async function () {
    var a = "a".repeat(40);
    var b = "b".repeat(40);
    var body = fallback._requestFor([a], [b]).toString();

    expect(body).toBe("0048want " + a + " ofs-delta no-progress\n0000" + "0032have " + b + "\n" + "0009done\n");

    var { Readable } = require("stream");
    var chunks = [];
    var unwrap = fallback._unwrap();
    unwrap.on("data", (chunk) => chunks.push(chunk));
    await new Promise(function (resolve, reject) {
      unwrap.on("end", resolve);
      unwrap.on("error", reject);
      Readable.from([Buffer.from("0008NAK\nPA"), Buffer.from("CKrest")]).pipe(unwrap);
    });
    expect(Buffer.concat(chunks).toString()).toBe("PACKrest");

    var refused = fallback._unwrap();
    var failed = await new Promise(function (resolve) {
      refused.on("error", resolve);
      refused.on("data", function () {});
      refused.end(Buffer.from("0011ERR nope yes\n"));
    });
    expect(failed.message).toContain("nope");
  });
});
