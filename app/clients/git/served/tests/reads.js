describe("git store served: reads on the normal route", function () {
  // Shadow mode's set-up: a blog on the git client with a clone, a memory
  // store per blog (shared with the served path through served/context.js),
  // shadow mode on for every blog so the store can be filled from EBS first
  var setup = require("clients/git/shadow/tests/setup");
  var Client = require("clients/git/tests/setup/client");
  var config = require("config");
  var fs = require("fs-extra");
  var http = require("http");
  var path = require("path");
  var repo = require("clients/git/repo");
  var shadow = require("clients/git/shadow");
  var { manifest } = require("clients/git/store");

  setup();

  // console.log is already the shadow set-up's spy: it keeps shadow mode's
  // lines in ctx.lines, and now the served path's in ctx.servedLines
  beforeEach(function () {
    var ctx = this;
    ctx.servedLines = [];
    console.log.and.callFake(function () {
      var line = Array.prototype.join.call(arguments, " ");
      if (line.indexOf("[git-store-shadow]") !== -1) ctx.lines.push(line);
      if (line.indexOf("[git-store-served]") !== -1) ctx.servedLines.push(line);
    });
  });

  // Fills the store from EBS (serve off), then switches the blog on
  async function mirrorAndSwitch(ctx) {
    config.git_store.serve = "";
    await setup.expectMirrored(ctx);
    config.git_store.serve = String(ctx.blog.id);
  }

  function lines(ctx, pattern) {
    return ctx.lines.concat(ctx.servedLines).filter(function (line) {
      return pattern.test(line);
    });
  }

  async function lineMatching(ctx, pattern) {
    for (var i = 0; i < 100; i++) {
      var found = lines(ctx, pattern);
      if (found.length) return found;
      await new Promise(function (resolve) {
        setTimeout(resolve, 20);
      });
    }

    throw new Error("No log line matched " + pattern);
  }

  function request(ctx, method, suffix, options) {
    options = options || {};

    var parsed = new URL(ctx.repoUrl);
    var user = decodeURIComponent(parsed.username);
    var token = options.auth === "wrong" ? "wrong" : decodeURIComponent(parsed.password);
    var headers = Object.assign({}, options.headers);

    if (options.auth !== "none") headers.Authorization = "Basic " + Buffer.from(user + ":" + token).toString("base64");

    return new Promise(function (resolve, reject) {
      var req = http.request(
        {
          method: method,
          hostname: "127.0.0.1",
          port: ctx.server.port,
          path: "/clients/git/end/" + ctx.blog.handle + ".git" + suffix,
          headers: headers,
        },
        function (res) {
          var chunks = [];
          res.on("data", function (chunk) {
            chunks.push(chunk);
          });
          res.on("end", function () {
            resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("latin1") });
          });
        }
      );

      req.on("error", reject);
      req.end(options.body);
    });
  }

  async function keys(store) {
    var found = [];
    for await (var entry of store.list("")) found.push(entry.key);
    return found.sort();
  }

  function directory(ctx, name) {
    return path.join(ctx.tmp, name);
  }

  async function refsOf(client) {
    return (await client.git(["for-each-ref", "--format=%(objectname) %(refname)", "refs/remotes/origin", "refs/tags"])).stdout;
  }

  // Moves the EBS repository out of the way, so that anything which still
  // reads it fails
  async function hideEbs(ctx) {
    ctx.hidden = ctx.gitDir + ".hidden";
    await fs.move(ctx.gitDir, ctx.hidden);
  }

  async function restoreEbs(ctx) {
    if (ctx.hidden) await fs.move(ctx.hidden, ctx.gitDir);
    ctx.hidden = null;
  }

  afterEach(async function () {
    await restoreEbs(this);
  });

  it("serves the advertisements, clones and fetches from the store, with EBS out of the way", async function () {
    await this.local.writeAndPush("/a.txt", "A");
    await this.local.git(["tag", "light"]);
    await this.local.git(["tag", "-a", "annotated", "-m", "An annotated tag"]);
    await this.local.push(["origin", "--tags"]);

    var ebsAdvertised = (await this.local.git(["ls-remote", this.repoUrl])).stdout;
    var ebsReceive = await request(this, "GET", "/info/refs?service=git-receive-pack");
    var fromEbs = await Client.clone({ url: this.repoUrl, directory: directory(this, "from-ebs") });

    await mirrorAndSwitch(this);
    await hideEbs(this);

    expect((await this.local.git(["ls-remote", this.repoUrl])).stdout).toBe(ebsAdvertised);

    // The receive-pack advertisement is EBS's, byte for byte
    var storeReceive = await request(this, "GET", "/info/refs?service=git-receive-pack");
    expect(storeReceive.status).toBe(200);
    expect(storeReceive.headers["content-type"]).toBe("application/x-git-receive-pack-advertisement");
    expect(storeReceive.body).toBe(ebsReceive.body);

    var fromStore = await Client.clone({ url: this.repoUrl, directory: directory(this, "from-store") });

    expect(await fromStore.head()).toBe(await this.local.head());
    expect(await refsOf(fromStore)).toBe(await refsOf(fromEbs));
    expect((await fromStore.try(["fsck", "--strict"])).code).toBe(0);
    expect(await fromStore.tree()).toEqual(await fromEbs.tree());

    // One push behind: pushed with the switch off, then fetched with it on
    await restoreEbs(this);
    config.git_store.serve = "";
    await this.local.writeAndPush("/b.txt", "B");
    await mirrorAndSwitch(this);
    await hideEbs(this);

    await fromStore.git(["-c", "transfer.fsckObjects=true", "fetch", "origin"]);
    expect((await fromStore.git(["rev-parse", "origin/master"])).stdout.trim()).toBe(await this.local.head());
    expect((await fromStore.try(["fsck", "--strict"])).code).toBe(0);

    var id = this.blog.id;

    expect((await lineMatching(this, /\[git-store-served\] .* op=advertise /))[0]).toMatch(
      new RegExp("blog=" + id + " op=advertise outcome=ok ms=\\d+ firstByteMs=\\d+ requests=\\d+ bytesDown=\\d+ bytesSent=\\d+$")
    );
    expect((await lineMatching(this, /\[git-store-served\] .* op=receive-advertise outcome=ok /)).length).toBeGreaterThan(0);
    expect((await lineMatching(this, /\[git-store-served\] .* op=clone outcome=ok /)).length).toBeGreaterThan(0);
    expect((await lineMatching(this, /\[git-store-served\] .* op=fetch outcome=ok /)).length).toBeGreaterThan(0);

    // IDs only
    var handle = this.blog.handle;
    lines(this, /\[git-store-served\]/).forEach(function (line) {
      expect(line).not.toContain(handle);
    });
  });

  it("answers the HEAD probe from the manifest", async function () {
    await this.local.writeAndPush("/a.txt", "A");
    var ebs = await request(this, "GET", "/HEAD");

    await mirrorAndSwitch(this);
    await hideEbs(this);

    var served = await request(this, "GET", "/HEAD");

    expect(served.status).toBe(200);
    expect(served.body).toBe(ebs.body);
    expect(served.body).toBe("ref: refs/heads/master\n");
  });

  it("refuses a shallow clone with a remote error", async function () {
    await this.local.writeAndPush("/a.txt", "A");
    await mirrorAndSwitch(this);

    var shallow = await Client.clone({ url: this.repoUrl, directory: directory(this, "shallow"), args: ["--depth", "1"] }).then(
      function () {
        return null;
      },
      function (err) {
        return err;
      }
    );

    expect(shallow).not.toBe(null);
    // The advertisement offers no shallow, so git refuses before asking; a
    // client which asks anyway is sent an ERR packet ("remote error")
    expect(shallow.stderr).toMatch(/does not support shallow|remote error/);
  });

  it("says so when the store has no copy, and never serves an empty repository", async function () {
    // A blog switched on before its store was filled (nothing has been
    // pushed, so nothing mirrored)
    config.git_store.serve = String(this.blog.id);

    var advertised = await request(this, "GET", "/info/refs?service=git-upload-pack");
    expect(advertised.status).toBe(503);
    expect(advertised.body).toContain("no copy");

    var receiving = await request(this, "GET", "/info/refs?service=git-receive-pack");
    expect(receiving.status).toBe(503);

    var clone = await Client.clone({ url: this.repoUrl, directory: directory(this, "nothing") }).then(
      function () {
        return null;
      },
      function (err) {
        return err;
      }
    );
    expect(clone).not.toBe(null);
  });

  it("refuses bad authentication as before", async function () {
    await this.local.writeAndPush("/a.txt", "A");
    await mirrorAndSwitch(this);

    for (var auth of ["wrong", "none"]) {
      var response = await request(this, "GET", "/info/refs?service=git-upload-pack", { auth: auth });
      expect(response.status).toBe(401);

      var post = await request(this, "POST", "/git-upload-pack", { auth: auth, body: "0000" });
      expect(post.status).toBe(401);
    }
  });

  it("answers what is not a git request as the EBS route does", async function () {
    await this.local.writeAndPush("/a.txt", "A");

    var suffixes = [
      ["GET", "/info/refs"],
      ["GET", "/info/refs?service=git-other"],
      ["POST", "/git-other-pack"],
      ["PUT", "/info/refs?service=git-upload-pack"],
    ];
    var ebs = [];

    for (var pair of suffixes) ebs.push((await request(this, pair[0], pair[1])).status);

    await mirrorAndSwitch(this);

    for (var i = 0; i < suffixes.length; i++) {
      expect((await request(this, suffixes[i][0], suffixes[i][1])).status).toBe(ebs[i]);
    }
  });

  it("never shadows a switched blog", async function () {
    await this.local.writeAndPush("/a.txt", "A");
    await mirrorAndSwitch(this);

    var store = this.stores[this.blog.id];
    var seq = (await manifest.read(store)).seq;

    // Blot's write is made in the store itself (served/commit.js), once, and
    // nothing is mirrored for it
    await new Promise(
      function (resolve, reject) {
        repo.commit(this.blog.id, { path: "/blot.txt", contents: "Blot" }, function (err) {
          return err ? reject(err) : resolve();
        });
      }.bind(this)
    );

    // A mirror asked for (the backfill, the verifier) is skipped
    var mirrored = await shadow.mirror(this.blog.id, { reason: "backfill" });
    expect(mirrored.outcome).toBe("skipped");
    expect(mirrored.detail).toBe("served from the store");

    await shadow.idle(this.blog.id);

    // The write's own swap (a compaction may follow it); no mirror's
    expect(this.shadowLines("write").length).toBe(0);
    expect(this.shadowLines("push").filter((line) => line.indexOf("outcome=skipped") === -1).length).toBe(0);
    expect((await manifest.read(store)).seq).toBeGreaterThan(seq);
  });

  it("drops shadow work queued before the switch", async function () {
    await this.local.writeAndPush("/a.txt", "A");
    await shadow.idle(this.blog.id);

    var store = this.stores[this.blog.id];
    var seq = (await manifest.read(store)).seq;

    // A mirror queued with the switch off; the switch goes on before it
    // starts (it waits a moment after being queued)
    await this.local.commitFiles({ "/b.txt": "B" });
    config.git_store.shadow = "";
    await this.local.push();
    config.git_store.shadow = "all";

    var queued = shadow.mirror(this.blog.id, { reason: "push" });
    config.git_store.serve = String(this.blog.id);

    expect((await queued).outcome).toBe("skipped");
    await shadow.idle(this.blog.id);

    expect((await manifest.read(store)).seq).toBe(seq);
    expect(lines(this, / op=push outcome=skipped detail="served from the store"/).length).toBe(1);
  });
});
