describe("git store shadow mode: mirroring", function () {
  var setup = require("./setup");
  var shadow = require("clients/git/shadow");
  var repo = require("clients/git/repo");
  var { manifest } = require("clients/git/store");

  setup();

  function commit(ctx, change) {
    return new Promise(function (resolve, reject) {
      repo.commit(ctx.blog.id, change, function (err) {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  it("imports on the first push and mirrors the next through receive", async function () {
    await this.local.writeAndPush("/a.txt", "A");
    await setup.expectMirrored(this);

    expect(this.shadowLines("import").length).toBe(1);
    expect(this.shadowLines("import")[0]).toContain("outcome=imported");

    await this.local.writeAndPush("/b.txt", "B");
    var current = await setup.expectMirrored(this);

    var pushes = this.shadowLines("push");
    expect(pushes.length).toBe(1);
    expect(pushes[0]).toContain("outcome=ok");
    expect(pushes[0]).toMatch(/ storeMs=\d+ receiveMs=\d+ ebsMs=\d+ requests=\d+ bytesUp=\d+ bytesDown=\d+ refs=1 /);
    expect(current.refs["refs/heads/master"]).toBe(await this.local.head());

    // Blog handles stay out of the logs
    var handle = this.blog.handle;
    this.lines.forEach(function (line) {
      expect(line).not.toContain(handle);
    });
  });

  it("imports an EBS repository which already has history when the store is empty", async function () {
    // History pushed while shadow mode was off
    var shadowSetting = require("config").git_store.shadow;
    require("config").git_store.shadow = "";
    await this.local.writeAndPush("/a.txt", "A");
    await this.local.writeAndPush("/b.txt", "B");
    require("config").git_store.shadow = shadowSetting;

    expect(this.stores[this.blog.id]).toBeUndefined();

    await this.local.writeAndPush("/c.txt", "C");
    await setup.expectMirrored(this);

    expect(this.shadowLines("import").length).toBe(1);
    expect(this.shadowLines("push").length).toBe(0);
  });

  it("mirrors a force push", async function () {
    await this.local.writeAndPush("/a.txt", "A");
    await this.local.writeAndPush("/b.txt", "B");
    await setup.expectMirrored(this);

    await this.local.git(["reset", "--hard", "HEAD~1"]);
    await this.local.commitFiles({ "/c.txt": "C" });
    await this.local.push(["--force", "origin", "master"]);

    var current = await setup.expectMirrored(this);
    expect(current.refs["refs/heads/master"]).toBe(await this.local.head());
    expect(this.shadowLines("push").pop()).toContain("outcome=ok");
  });

  it("mirrors tags, and their deletion", async function () {
    await this.local.writeAndPush("/a.txt", "A");
    await this.local.git(["tag", "light"]);
    await this.local.git(["tag", "-a", "annotated", "-m", "An annotated tag"]);
    await this.local.push(["origin", "--tags"]);

    var current = await setup.expectMirrored(this);
    expect(Object.keys(current.refs).sort()).toEqual(["refs/heads/master", "refs/tags/annotated", "refs/tags/light"]);

    await this.local.push(["origin", ":refs/tags/light"]);

    current = await setup.expectMirrored(this);
    expect(Object.keys(current.refs).sort()).toEqual(["refs/heads/master", "refs/tags/annotated"]);
    expect(this.shadowLines("push").pop()).toContain("outcome=ok");
  });

  it("mirrors a branch deletion the store can take, and logs one it cannot", async function () {
    await this.local.writeAndPush("/a.txt", "A");
    var master = await this.local.head();

    // An older repository may have branches besides master, which a push can
    // no longer change: an import carries them over
    setup.git(this.gitDir, ["update-ref", "refs/heads/legacy", master]);
    this.stores[this.blog.id] = undefined;
    shadow._setObjectStore(
      function (blogID) {
        return (this.stores[blogID] = this.stores[blogID] || require("clients/git/store").createMemoryStore());
      }.bind(this)
    );
    await shadow.mirror(this.blog.id);
    var current = await setup.expectMirrored(this);
    expect(current.refs["refs/heads/legacy"]).toBe(master);

    // Removed on disk, it cannot be removed by a push: logged clearly
    setup.git(this.gitDir, ["update-ref", "-d", "refs/heads/legacy"]);
    await shadow.mirror(this.blog.id);
    await shadow.idle(this.blog.id);

    var mismatch = this.shadowLines("push").filter(function (line) {
      return line.indexOf("outcome=mismatch") !== -1;
    });
    expect(mismatch.length).toBe(1);
    expect(mismatch[0]).toContain("refs/heads/legacy");
  });

  it("mirrors Blot's writes through the store's commit, with the same commit IDs", async function () {
    await this.local.writeAndPush("/a.txt", "A");
    await setup.expectMirrored(this);

    await commit(this, { path: "/Drafts/hello.txt", contents: "Hello" });
    var current = await setup.expectMirrored(this);
    var writes = this.shadowLines("write");

    expect(writes.length).toBe(1);
    expect(writes[0]).toContain("outcome=ok");
    expect(writes[0]).toMatch(/ storeMs=\d+ commitMs=\d+ ebsMs=\d+ requests=\d+ bytesUp=\d+ bytesDown=\d+ refs=1 /);
    expect(current.refs["refs/heads/master"]).toBe(setup.ebsRefs(this.gitDir)["refs/heads/master"]);

    await commit(this, { path: "/Drafts/hello.txt", contents: null });
    await commit(this, { path: "/b.txt", contents: Buffer.from("B") });
    await setup.expectMirrored(this);

    writes = this.shadowLines("write");
    expect(writes.length).toBe(3);
    writes.forEach(function (line) {
      expect(line).toContain("outcome=ok");
    });

    // Nothing fell back to a mirror
    expect(this.shadowLines("push").length).toBe(0);
  });

  it("falls back to a mirror when the store missed a change", async function () {
    await this.local.writeAndPush("/a.txt", "A");
    await setup.expectMirrored(this);

    // A push the store never heard of
    require("config").git_store.shadow = "";
    await this.local.writeAndPush("/b.txt", "B");
    require("config").git_store.shadow = "all";

    await commit(this, { path: "/c.txt", contents: "C" });
    await setup.expectMirrored(this);

    expect(this.shadowLines("write")[0]).toContain("outcome=mismatch");
    expect(this.shadowLines("push").pop()).toContain("outcome=ok");
  });

  it("compacts in the background after mirroring", async function () {
    await this.local.writeAndPush("/a.txt", "A");

    // A push each, so each has a pack and a seq of its own: once more than
    // keepRecent (4) pushes are past, the small packs are worth merging
    for (var i = 0; i < 7; i++) {
      await shadow.idle(this.blog.id);
      await this.local.writeAndPush("/" + i + ".txt", String(i));
    }

    await setup.expectMirrored(this);

    var compactions = this.shadowLines("compact");
    expect(compactions.length).toBeGreaterThan(0);
    compactions.forEach(function (line) {
      expect(line).toMatch(/outcome=(compacted|nothing|superseded) storeMs=\d+ requests=\d+ /);
    });
    expect(compactions.some((line) => / outcome=compacted /.test(line))).toBe(true);

    // An import's pack and one for each push since, less what was merged
    var current = await manifest.read(this.stores[this.blog.id]);
    expect(current.packs.length).toBeLessThan(8);
  });

  it("runs a mirror's git in the background lane, with the limiter's settings", async function () {
    var limiter = require("clients/git/limiter");
    var spy = require("clients/git/tests/setup/spyGit")();
    var caps = limiter.stats();
    var gitDir = this.gitDir;
    var cacheDirectory = require("config").git_store.cache_directory;
    var release = function () {};

    await this.local.writeAndPush("/a.txt", "A");
    await setup.expectMirrored(this);

    // Shadow's own commands in the EBS repository, and the store's, which run
    // in its scratch space in the cache
    function shadowOwn(command) {
      return (
        command.gitDir === gitDir &&
        /(pack-objects --revs --stdout --thin|for-each-ref --format=%\(objectname\) %\(refname\) refs\/heads refs\/tags|cat-file --batch-check=%\(objectname\) %\(objecttype\))/.test(command.args)
      );
    }
    function store(command) {
      return command.gitDir.indexOf(cacheDirectory) === 0 || command.args.indexOf(cacheDirectory) !== -1;
    }
    function mirrors(command) {
      return shadowOwn(command) || store(command);
    }

    limiter.reset({ background: 1 });
    spy.install();

    try {
      // The background lane is full; the interactive lane is not
      var holding = limiter.run("background", function () {
        return new Promise(function (resolve) {
          release = resolve;
        });
      });

      await this.local.writeAndPush("/b.txt", "B");

      // Well past the mirror's start: it is waiting for the place
      await new Promise(function (resolve) {
        setTimeout(resolve, 1500);
      });

      expect(spy.commands(mirrors)).toEqual([]);
      expect(this.shadowLines("push")).toEqual([]);
      expect(limiter.stats().background.waiting).toBeGreaterThan(0);

      release();
      await holding;
      await shadow.idle(this.blog.id);

      var own = spy.commands(shadowOwn);
      var theStore = spy.commands(store);

      expect(own.some((command) => /pack-objects --revs/.test(command.args))).toBe(true);
      expect(theStore.some((command) => /index-pack --stdin --fix-thin/.test(command.args))).toBe(true);

      // One background place: never two of them at once, and the pack made
      // for receive does not hold it while the store's index-pack waits
      expect(spy.mostAtOnce(mirrors)).toBe(1);

      // Shadow's own commands carry the limiter's memory settings
      own.forEach(function (command) {
        expect(command.args).toContain("-c pack.threads=1");
        expect(command.args).toContain("-c gc.auto=0");
      });
    } finally {
      release();
      spy.restore();
      limiter.reset({ interactive: caps.interactive.max, background: caps.background.max, gc: caps.gc.max });
    }

    var current = await setup.expectMirrored(this);
    expect(current.refs["refs/heads/master"]).toBe(await this.local.head());
    expect(this.shadowLines("push").pop()).toContain("outcome=ok");
  });
});
