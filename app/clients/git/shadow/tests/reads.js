describe("git store shadow mode: the test-only read route", function () {
  var setup = require("./setup");
  var Client = require("clients/git/tests/setup/client");
  var config = require("config");
  var http = require("http");
  var path = require("path");
  var { manifest } = require("clients/git/store");

  setup();

  // The same repository, on the route served from the store
  function storeUrl(ctx) {
    return ctx.repoUrl.replace("/clients/git/end/", "/clients/git/store-end/");
  }

  // Sends a request to the test server. auth: "valid" (the spec's
  // credentials), "wrong" (a bad token) or "none".
  function request(ctx, method, route, suffix, options) {
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
          path: "/clients/git/" + route + "/" + ctx.blog.handle + ".git" + suffix,
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

  // Every key in the blog's store, to check that nothing was written
  async function keys(store) {
    var found = [];
    for await (var entry of store.list("")) found.push(entry.key);
    return found.sort();
  }

  // A line is logged once the response has finished, a moment after git exits
  async function lineMatching(ctx, pattern) {
    for (var i = 0; i < 100; i++) {
      var found = ctx.lines.filter(function (line) {
        return pattern.test(line);
      });
      if (found.length) return found;
      await new Promise(function (resolve) {
        setTimeout(resolve, 20);
      });
    }

    throw new Error("No log line matched " + pattern + "\n" + ctx.lines.join("\n"));
  }

  function directory(ctx, name) {
    return path.join(ctx.tmp, name);
  }

  async function refsOf(client) {
    return (await client.git(["for-each-ref", "--format=%(objectname) %(refname)", "refs/remotes/origin", "refs/tags"])).stdout;
  }

  it("clones and fetches from the store, with the same refs as EBS and a clean fsck", async function () {
    await this.local.writeAndPush("/a.txt", "A");
    await this.local.git(["tag", "light"]);
    await this.local.git(["tag", "-a", "annotated", "-m", "An annotated tag"]);
    await this.local.push(["origin", "--tags"]);
    await setup.expectMirrored(this);

    // The advertisements agree
    var ebsAdvertised = (await this.local.git(["ls-remote", this.repoUrl])).stdout;
    expect((await this.local.git(["ls-remote", storeUrl(this)])).stdout).toBe(ebsAdvertised);

    var fromStore = await Client.clone({ url: storeUrl(this), directory: directory(this, "from-store") });
    var fromEbs = await Client.clone({ url: this.repoUrl, directory: directory(this, "from-ebs") });

    expect(await fromStore.head()).toBe(await this.local.head());
    expect(await refsOf(fromStore)).toBe(await refsOf(fromEbs));
    expect((await fromStore.try(["fsck", "--strict"])).code).toBe(0);
    expect(await fromStore.tree()).toEqual(await fromEbs.tree());

    // One push behind: the client has everything but the newest
    await this.local.writeAndPush("/b.txt", "B");
    await setup.expectMirrored(this);

    await fromStore.git(["-c", "transfer.fsckObjects=true", "fetch", "origin"]);
    await fromEbs.git(["fetch", "origin"]);

    expect(await refsOf(fromStore)).toBe(await refsOf(fromEbs));
    expect((await fromStore.git(["rev-parse", "origin/master"])).stdout.trim()).toBe(await this.local.head());
    expect((await fromStore.try(["fsck", "--strict"])).code).toBe(0);
  });

  it("writes nothing to the store while serving", async function () {
    await this.local.writeAndPush("/a.txt", "A");
    await setup.expectMirrored(this);

    var store = this.stores[this.blog.id];
    var before = await keys(store);
    var read = (await manifest.read(store)).seq;

    await Client.clone({ url: storeUrl(this), directory: directory(this, "quiet") });

    expect(await keys(store)).toEqual(before);
    expect((await manifest.read(store)).seq).toBe(read);
    expect(this.shadowLines("push").length).toBe(0);
  });

  it("logs a line for each request, from the store and from EBS", async function () {
    await this.local.writeAndPush("/a.txt", "A");
    await setup.expectMirrored(this);

    var fromStore = await Client.clone({ url: storeUrl(this), directory: directory(this, "log-store") });
    var fromEbs = await Client.clone({ url: this.repoUrl, directory: directory(this, "log-ebs") });

    var id = this.blog.id;

    expect((await lineMatching(this, / op=advertise source=store /))[0]).toMatch(
      new RegExp("blog=" + id + " op=advertise source=store outcome=ok storeMs=\\d+ firstByteMs=\\d+ requests=\\d+ bytesDown=\\d+ bytesSent=\\d+$")
    );
    expect((await lineMatching(this, / op=clone source=store /))[0]).toMatch(
      new RegExp("blog=" + id + " op=clone source=store outcome=ok storeMs=\\d+ firstByteMs=\\d+ requests=\\d+ bytesDown=\\d+ bytesSent=\\d+$")
    );
    expect((await lineMatching(this, / op=advertise source=ebs /))[0]).toMatch(
      new RegExp("blog=" + id + " op=advertise source=ebs outcome=ok ebsMs=\\d+ firstByteMs=\\d+ bytesSent=\\d+$")
    );
    expect((await lineMatching(this, / op=clone source=ebs /))[0]).toMatch(
      new RegExp("blog=" + id + " op=clone source=ebs outcome=ok ebsMs=\\d+ firstByteMs=\\d+ bytesSent=\\d+$")
    );

    // A fetch is told from a clone by its have lines
    await this.local.writeAndPush("/b.txt", "B");
    await setup.expectMirrored(this);

    await fromStore.git(["fetch", "origin"]);
    await fromEbs.git(["fetch", "origin"]);

    expect((await lineMatching(this, / op=fetch source=store outcome=ok /))[0]).toMatch(/ storeMs=\d+ firstByteMs=\d+ requests=\d+ bytesDown=\d+ bytesSent=\d+$/);
    expect((await lineMatching(this, / op=fetch source=ebs outcome=ok /))[0]).toMatch(/ ebsMs=\d+ firstByteMs=\d+ bytesSent=\d+$/);

    // IDs only
    var handle = this.blog.handle;
    this.lines.forEach(function (line) {
      expect(line).not.toContain(handle);
    });
  });

  it("times a gzipped fetch from EBS as a fetch", async function () {
    await this.local.writeAndPush("/a.txt", "A");
    await setup.expectMirrored(this);

    function packet(text) {
      return (text.length + 4).toString(16).padStart(4, "0") + text;
    }

    var advertised = await request(this, "GET", "end", "/info/refs?service=git-upload-pack");
    var tip = /([0-9a-f]{40}) HEAD/.exec(advertised.body)[1];
    var lines = [packet("want " + tip + " multi_ack_detailed side-band-64k ofs-delta\n"), "0000"];

    // Haves the repository does not know, in a body git would gzip
    for (var i = 1; i <= 60; i++) lines.push(packet("have " + i.toString(16).padStart(40, "0") + "\n"));

    lines.push(packet("done\n"));

    var body = Buffer.from(lines.join(""));

    var response = await request(this, "POST", "end", "/git-upload-pack", {
      body: require("zlib").gzipSync(body),
      headers: { "Content-Type": "application/x-git-upload-pack-request", "Content-Encoding": "gzip" },
    });

    expect(response.status).toBe(200);
    await lineMatching(this, / op=fetch source=ebs outcome=ok /);
  });

  it("notes shallow and partial requests on the EBS line, and only those", async function () {
    await this.local.writeAndPush("/a.txt", "A");
    await this.local.writeAndPush("/b.txt", "B");
    await setup.expectMirrored(this);

    var ctx = this;
    function ebsLines() {
      return ctx.lines.filter(function (line) {
        return / source=ebs /.test(line) && / op=(clone|fetch) /.test(line);
      });
    }

    // A normal clone and fetch carry none of the fields
    var normal = await Client.clone({ url: this.repoUrl, directory: directory(this, "shape-normal") });
    await lineMatching(this, / op=clone source=ebs outcome=ok /);
    await this.local.writeAndPush("/c.txt", "C");
    await normal.git(["fetch", "origin"]);
    await lineMatching(this, / op=fetch source=ebs outcome=ok /);
    expect(ebsLines().length).toBeGreaterThan(1);
    ebsLines().forEach(function (line) {
      expect(line).not.toMatch(/ (deepen|shallow|filter)=/);
    });

    // A shallow clone sends a deepen line, and a fetch into it shallow lines
    var shallow = await Client.clone({ url: this.repoUrl, directory: directory(this, "shape-shallow"), args: ["--depth", "1"] });
    await lineMatching(this, / op=clone source=ebs outcome=ok .* deepen=deepen$/);
    await this.local.writeAndPush("/d.txt", "D");
    await shallow.git(["fetch", "origin"]);
    await lineMatching(this, / op=fetch source=ebs outcome=ok .* shallow=1$/);

    // A repository which does not allow filters does not advertise the
    // capability, so a real client would not send one: send the requests by
    // hand, plain and gzipped
    var advertised = await request(this, "GET", "end", "/info/refs?service=git-upload-pack");
    var tip = /([0-9a-f]{40}) HEAD/.exec(advertised.body)[1];

    function packet(text) {
      return (text.length + 4).toString(16).padStart(4, "0") + text;
    }

    var plain = Buffer.from(
      packet("want " + tip + " multi_ack_detailed side-band-64k ofs-delta\n") +
        packet("deepen-since 1700000000\n") +
        packet("deepen-not refs/heads/other\n") +
        packet("filter blob:none\n") +
        "0000" +
        packet("done\n")
    );
    var zipped = require("zlib").gzipSync(
      Buffer.from(packet("want " + tip + " ofs-delta\n") + packet("filter tree:0\n") + "0000" + packet("done\n"))
    );

    await request(this, "POST", "end", "/git-upload-pack", {
      body: plain,
      headers: { "Content-Type": "application/x-git-upload-pack-request" },
    });
    await request(this, "POST", "end", "/git-upload-pack", {
      body: zipped,
      headers: { "Content-Type": "application/x-git-upload-pack-request", "Content-Encoding": "gzip" },
    });

    await lineMatching(this, / deepen=deepen-since\+deepen-not filter=blob:none$/);
    await lineMatching(this, / filter=tree:0$/);
  });

  it("gives upload-pack the whole body while the fetch waits for a place in the git limiter", async function () {
    var limiter = require("clients/git/limiter");

    await this.local.writeAndPush("/a.txt", "A");
    await setup.expectMirrored(this);

    function packet(text) {
      return (text.length + 4).toString(16).padStart(4, "0") + text;
    }

    var advertised = await request(this, "GET", "end", "/info/refs?service=git-upload-pack");
    var tip = /([0-9a-f]{40}) HEAD/.exec(advertised.body)[1];
    var body = packet("want " + tip + " multi_ack_detailed side-band-64k ofs-delta\n") + "0000" + packet("done\n");

    var caps = limiter.stats();
    limiter.reset({ interactive: 1 });

    try {
      // The interactive lane is busy while the body arrives
      var held = limiter.outside(function () {
        return limiter.run("interactive", function () {
          return new Promise(function (resolve) {
            setTimeout(resolve, 1000);
          });
        });
      });

      var response = await request(this, "POST", "end", "/git-upload-pack", {
        body: body,
        headers: { "Content-Type": "application/x-git-upload-pack-request" },
      });

      await held;
    } finally {
      limiter.reset({ interactive: caps.interactive.max });
    }

    expect(response.status).toBe(200);
    expect(response.body).toContain("PACK");
    await lineMatching(this, / op=clone source=ebs outcome=ok /);
  });

  it("gives a 404 for a blog which is not in shadow mode", async function () {
    await this.local.writeAndPush("/a.txt", "A");
    await setup.expectMirrored(this);

    var saved = config.git_store.shadow;

    try {
      config.git_store.shadow = "";
      var off = await request(this, "GET", "store-end", "/info/refs?service=git-upload-pack");
      expect(off.status).toBe(404);

      config.git_store.shadow = "blog_someone_else";
      var other = await request(this, "GET", "store-end", "/info/refs?service=git-upload-pack");
      expect(other.status).toBe(404);

      var clone = await Client.clone({ url: storeUrl(this), directory: directory(this, "refused") }).then(
        function () {
          return null;
        },
        function (err) {
          return err;
        }
      );
      expect(clone).not.toBe(null);

      // The normal route is unchanged
      var normal = await request(this, "GET", "end", "/info/refs?service=git-upload-pack");
      expect(normal.status).toBe(200);
    } finally {
      config.git_store.shadow = saved;
    }
  });

  it("gives a 404 for a blog which is not on the git client", async function () {
    await this.local.writeAndPush("/a.txt", "A");
    await setup.expectMirrored(this);

    await new Promise(
      function (resolve, reject) {
        require("models/blog").set(this.blog.id, { client: "" }, function (err) {
          return err ? reject(err) : resolve();
        });
      }.bind(this)
    );

    var response = await request(this, "GET", "store-end", "/info/refs?service=git-upload-pack");
    expect(response.status).toBe(404);

    await new Promise(
      function (resolve, reject) {
        require("models/blog").set(this.blog.id, { client: "git" }, function (err) {
          return err ? reject(err) : resolve();
        });
      }.bind(this)
    );
  });

  it("says so when the store has no copy yet", async function () {
    var response = await request(this, "GET", "store-end", "/info/refs?service=git-upload-pack");

    expect(response.status).toBe(503);
    expect(response.body).toContain("no copy");
  });

  it("refuses a push, with a message, and changes nothing", async function () {
    await this.local.writeAndPush("/a.txt", "A");
    await setup.expectMirrored(this);

    var master = await this.local.head();
    var store = this.stores[this.blog.id];
    var before = await keys(store);

    await this.local.commitFiles({ "/b.txt": "B" });
    var pushed = await this.local.try(["push", storeUrl(this), "master"]);

    expect(pushed.code).not.toBe(0);
    expect(pushed.stderr).toContain("pushes go to the normal URL");

    var raw = await request(this, "POST", "store-end", "/git-receive-pack", {
      body: "0000",
      headers: { "Content-Type": "application/x-git-receive-pack-request" },
    });
    expect(raw.status).toBe(403);
    expect(raw.body).toContain("pushes go to the normal URL");

    expect(await this.local.remoteHead("master")).toBe(master);
    expect(setup.ebsRefs(this.gitDir)["refs/heads/master"]).toBe(master);
    expect(await keys(store)).toEqual(before);
  });

  it("refuses bad authentication as the normal route does", async function () {
    await this.local.writeAndPush("/a.txt", "A");
    await setup.expectMirrored(this);

    var suffix = "/info/refs?service=git-upload-pack";

    for (var auth of ["wrong", "none"]) {
      var normal = await request(this, "GET", "end", suffix, { auth: auth });
      var store = await request(this, "GET", "store-end", suffix, { auth: auth });

      expect(normal.status).toBe(401);
      expect(store.status).toBe(normal.status);
      expect(store.headers["www-authenticate"]).toBe(normal.headers["www-authenticate"]);

      var post = await request(this, "POST", "store-end", "/git-upload-pack", { auth: auth, body: "0000" });
      expect(post.status).toBe(401);
    }
  });

});
